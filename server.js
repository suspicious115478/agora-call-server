// server.js

require('dotenv').config(); // Load environment variables from .env file

const express = require('express');
const admin = require('firebase-admin');
const axios = require('axios');

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
// This endpoint now expects 'callId' and 'calleeDeviceToken' from the calling client.
// It will directly look up 'channel' and 'token' under the 'callId' node.
app.post('/initiateCall', async (req, res) => {
  const { callId, calleeDeviceToken, callerId, calleeId } = req.body; // callerId and calleeId are for FCM message body

  if (!callId || !calleeDeviceToken || !callerId || !calleeId) {
    return res.status(400).json({ error: 'Missing required parameters: callId, calleeDeviceToken, callerId, or calleeId' });
  }

  try {
    // 1. Retrieve call details from Firebase
    // Assuming the path is db.ref('calls') -> callId -> { channel, token, etc. }
    const callRef = db.ref('calls').child(callId); // Assuming 'calls' is the parent node in your DB
    const snapshot = await callRef.once('value');
    const callData = snapshot.val(); // This directly contains { channel, token, etc. }

    if (!callData) {
      return res.status(404).json({ error: 'Call data not found for the provided callId.' });
    }

    const channelName = callData.channel;
    const agoraToken = callData.token;
    // You can also retrieve other fields like callData.isLocked, callData.secondaryAppId, callData.timestamp if needed

    if (!channelName || !agoraToken) {
        return res.status(404).json({ error: 'Agora channel or token not found in the Firebase data for this callId.' });
    }

    // Optional: Update status in Firebase (if you want to track it)
    // You'll need to ensure your Firebase structure includes a 'status' field at this level.
    // await callRef.update({ status: 'ringing' });


    // 2. Send FCM notification for ringing
    const message = {
      token: calleeDeviceToken, // Use the device token from the request body
      data: {
        type: 'incoming_call',
        callId: callId,
        callerId: callerId,
        channelName: channelName, // Retrieved directly from callData.channel
        agoraToken: agoraToken,   // Retrieved directly from callData.token
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
      apns: {
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

    res.status(200).json({ message: 'Call data retrieved and ringing sent', callId: callId });
  } catch (error) {
    console.error('Error initiating call:', error);
    res.status(500).json({ error: 'Failed to initiate call' });
  }
});

// 2. Endpoint to handle call acceptance (and potentially retrieve data if needed)
app.post('/acceptCall', async (req, res) => {
  const { callId, calleeId } = req.body;

  if (!callId || !calleeId) {
    return res.status(400).json({ error: 'Missing required parameters' });
  }

  try {
    const callRef = db.ref('calls').child(callId);
    const snapshot = await callRef.once('value');
    const callData = snapshot.val(); // Directly contains { channel, token, etc. }

    if (!callData) {
      return res.status(404).json({ error: 'Call not found' });
    }

    const channelName = callData.channel;
    const agoraToken = callData.token;

    if (!channelName || !agoraToken) {
        return res.status(404).json({ error: 'Agora channel or token not found in the Firebase data for this callId.' });
    }

    // Optional: Update status in Firebase (if you want to track it)
    // await callRef.update({ status: 'accepted' });

    res.status(200).json({
      message: 'Call accepted',
      agora: {
        channelName: channelName, // Retrieved directly from callData.channel
        token: agoraToken,         // Retrieved directly from callData.token
      },
    });
  } catch (error) {
    console.error('Error accepting call:', error);
    res.status(500).json({ error: 'Failed to accept call' });
  }
});

// 3. Endpoint to handle call ending
app.post('/endCall', async (req, res) => {
  const { callId } = req.body;

  if (!callId) {
    return res.status(400).json({ error: 'Missing required parameters' });
  }

  try {
    const callRef = db.ref('calls').child(callId);
    const snapshot = await callRef.once('value');
    const callData = snapshot.val(); // Directly contains { channel, token, etc. }

    if (!callData) {
      return res.status(404).json({ error: 'Call not found' });
    }

    // Optional: Update status in Firebase (if you want to track it)
    // await callRef.update({ status: 'ended' });

    res.status(200).json({ message: 'Call ended' });
  } catch (error) {
    console.error('Error ending call:', error);
    res.status(500).json({ error: 'Failed to end call' });
  }
});


const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
