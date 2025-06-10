// server.js

require('dotenv').config(); // Load environment variables from .env file

const express = require('express');
const admin = require('firebase-admin');
const axios = require('axios');
// Removed: const { RtcTokenBuilder, RtcRole } = require('agora-access-token'); // No longer generating Agora tokens here

const app = express();
app.use(express.json()); // Enable parsing of JSON request bodies

// --- Firebase Initialization ---
// For Render deployment, ensure this path points to the secret file mounted by Render.
// If running locally, you might still use require('./path/to/your/serviceAccountKey.json');
const serviceAccount = require('/etc/secrets/firebase_service_account.json');
process.env.GOOGLE_APPLICATION_CREDENTIALS = '/etc/secrets/firebase_service_account.json'; // Instructs Firebase Admin SDK to look for this file

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount), // Explicitly using credential from secret file
  databaseURL: process.env.FIREBASE_DATABASE_URL, // e.g., "https://your-project-id.firebaseio.com"
});

const db = admin.database(); // For Realtime Database
const messaging = admin.messaging(); // For FCM

// --- API Endpoints ---

// 1. Endpoint to initiate a call and send ringing payload
// This endpoint now expects 'callId', 'callerId', and 'calleeId' from the calling client.
// It will look up 'channel' and 'token' under the 'callId' node in Firebase.
app.post('/initiateCall', async (req, res) => {
  const { callId, callerId, calleeId } = req.body; // Primary app sends callId, callerId, and calleeId

  // --- Server-side validation ---
  if (!callId || !callerId || !calleeId) {
    return res.status(400).json({ error: 'Missing required parameters: callId, callerId, or calleeId' });
  }

  try {
    // --- STEP 1: Retrieve Agora channel and token for the specific callId from Firebase ---
    // Assuming the primary app or another server stores Agora details under 'calls_sessions/<callId>'
    const callSessionRef = db.ref('calls_sessions').child(callId);
    const callSessionSnapshot = await callSessionRef.once('value');
    const callSessionData = callSessionSnapshot.val();

    if (!callSessionData) {
      return res.status(404).json({ error: `Call session data not found for callId: ${callId}. Ensure call details are stored in 'calls_sessions' by primary app.` });
    }

    const channelName = callSessionData.channel; // Expected to be stored here
    const agoraToken = callSessionData.token;    // Expected to be stored here

    if (!channelName || !agoraToken) {
      return res.status(404).json({ error: `Agora channel or token not found under callId: ${callId} in Firebase.` });
    }

    // --- STEP 2: Retrieve the callee's FCM token from Firebase ---
    // This part remains similar to previous discussion, fetching the FCM token for the callee's device.
    // Assuming the secondary app stores its token at: `calls/<calleeId>/<secondaryDeviceId>/fcmToken`
    const calleeRef = db.ref('calls').child(calleeId); // This is where the secondary app stores its data

    const calleeSnapshot = await calleeRef.once('value');
    const calleeData = calleeSnapshot.val();

    if (!calleeData) {
      return res.status(404).json({ error: `Callee data not found for calleeId: ${calleeId}. Secondary app might not have registered its device.` });
    }

    let calleeDeviceToken = null;
    let calleeDeviceId = null;

    // Iterate through the callee's registered devices to find an FCM token
    // This assumes calleeData could contain multiple device IDs, each with an fcmToken
    for (const key in calleeData) {
        if (calleeData[key] && typeof calleeData[key] === 'object' && calleeData[key].fcmToken) {
            calleeDeviceId = key; // This is the secondary app's Android ID
            calleeDeviceToken = calleeData[key].fcmToken;
            console.log(`[Server /initiateCall] Found calleeDeviceToken: ${calleeDeviceToken} for deviceId: ${calleeDeviceId}`);
            break; // Found the token, stop searching (assuming one active token per user for calls)
        }
    }

    if (!calleeDeviceToken) {
      return res.status(404).json({ error: `FCM token not found for calleeId: ${calleeId}. Secondary device might not be active or registered its token.` });
    }

    // Optional: Update call status in Firebase (if you want to track it)
    // This assumes the 'calls_sessions' node can also have a 'status'
    await callSessionRef.update({ status: 'ringing', lastRingingAttempt: admin.database.ServerValue.TIMESTAMP });

    // --- STEP 3: Send FCM notification for ringing ---
    const message = {
      token: calleeDeviceToken, // Use the retrieved FCM token
      data: {
        type: 'incoming_call',
        callId: callId,
        callerId: callerId,
        channelName: channelName, // Retrieved from Firebase
        agoraToken: agoraToken,    // Retrieved from Firebase
      },
      notification: {
        title: 'Incoming Call',
        body: `${callerId} is calling you!`,
        sound: 'incoming_call.wav', // Custom sound for ringing (ensure it's bundled in app)
      },
      android: {
        priority: 'high',
        notification: {
          sound: 'incoming_call', // Reference to the sound file in res/raw (Android)
        },
      },
      apns: { // Apple Push Notification Service (for iOS, keep if you support iOS)
        headers: {
          'apns-priority': '10', // High priority for ringing
          'apns-push-type': 'alert', // Use 'alert' for visible notifications
          'apns-topic': 'YOUR_BUNDLE_ID', // **IMPORTANT: Replace with your iOS app's bundle ID for APNs**
        },
        payload: {
          aps: {
            alert: {
              title: 'Incoming Call',
              body: `${callerId} is calling you!`,
            },
            sound: 'incoming_call.wav', // Custom sound for ringing (ensure it's bundled in app) (iOS)
            'content-available': 1, // Crucial for background app wakeup (iOS)
          },
          // Custom data (repeated for APNs payload structure)
          callId: callId,
          callerId: callerId,
          channelName: channelName,
          agoraToken: agoraToken,
        },
      },
    };

    await messaging.send(message);

    res.status(200).json({ message: 'Call data retrieved and ringing sent', callId: callId, channelName: channelName, agoraToken: agoraToken });
  } catch (error) {
    console.error('[Server /initiateCall] Error initiating call:', error);
    res.status(500).json({ error: `Failed to initiate call: ${error.message}` });
  }
});

// 2. Endpoint to handle call acceptance (and potentially retrieve data if needed)
app.post('/acceptCall', async (req, res) => {
  const { callId, calleeId } = req.body; // calleeId is optional here if only callId is needed

  if (!callId) {
    return res.status(400).json({ error: 'Missing required parameter: callId' });
  }

  try {
    // We now look in 'calls_sessions' for the central call data
    const callSessionRef = db.ref('calls_sessions').child(callId);
    const snapshot = await callSessionRef.once('value');
    const callData = snapshot.val();

    if (!callData) {
      return res.status(404).json({ error: `Call data not found for the provided callId: ${callId}.` });
    }

    const channelName = callData.channel;
    const agoraToken = callData.token;

    if (!channelName || !agoraToken) {
        return res.status(404).json({ error: `Agora channel or token not found in the Firebase data for this callId: ${callId}.` });
    }

    // Optional: Update status in Firebase
    await callSessionRef.update({ status: 'accepted', acceptedBy: calleeId, acceptedAt: admin.database.ServerValue.TIMESTAMP });

    res.status(200).json({
      message: 'Call accepted',
      agora: {
        channelName: channelName,
        token: agoraToken,
      },
    });
  } catch (error) {
    console.error('[Server /acceptCall] Error accepting call:', error);
    res.status(500).json({ error: `Failed to accept call: ${error.message}` });
  }
});

// 3. Endpoint to handle call ending
app.post('/endCall', async (req, res) => {
  const { callId, userId, role } = req.body; // You might want to know who ended the call

  if (!callId) {
    return res.status(400).json({ error: 'Missing required parameter: callId' });
  }

  try {
    // We now look in 'calls_sessions' for the central call data
    const callSessionRef = db.ref('calls_sessions').child(callId);
    const snapshot = await callSessionRef.once('value');
    const callData = snapshot.val();

    if (!callData) {
      return res.status(404).json({ error: `Call not found for callId: ${callId}.` });
    }

    // Optional: Update status in Firebase (or remove the record)
    await callSessionRef.update({ status: 'ended', endedBy: userId, endedRole: role, endedAt: admin.database.ServerValue.TIMESTAMP });
    // Or to remove: await callSessionRef.remove();

    res.status(200).json({ message: 'Call ended' });
  } catch (error) {
    console.error('[Server /endCall] Error ending call:', error);
    res.status(500).json({ error: `Failed to end call: ${error.message}` });
  }
});


const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
