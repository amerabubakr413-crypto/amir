const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// ==================== In-Memory Storage (No Database) ====================
const rooms = new Map();

// ==================== Middleware ====================
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ==================== REST API ====================

// List all active rooms
app.get('/api/rooms', (req, res) => {
  const roomList = Array.from(rooms.entries()).map(([id, data]) => ({
    roomId: id,
    userCount: data.users.length,
    maxUsers: 5,
    createdAt: data.createdAt,
    hasVideo: !!data.currentVideo,
    hostName: data.users.find(u => u.isHost)?.name || null
  }));
  res.json({ success: true, count: roomList.length, rooms: roomList });
});

// Get room details
app.get('/api/rooms/:roomId', (req, res) => {
  const room = rooms.get(req.params.roomId.toUpperCase());
  if (!room) {
    return res.status(404).json({ success: false, error: 'Room not found' });
  }
  res.json({
    success: true,
    roomId: req.params.roomId.toUpperCase(),
    users: room.users.map(u => ({ 
      name: u.name, 
      isHost: u.isHost, 
      joinedAt: u.joinedAt,
      muted: u.muted 
    })),
    userCount: room.users.length,
    maxUsers: 5,
    currentVideo: room.currentVideo || null,
    createdAt: room.createdAt
  });
});

// Get room messages
app.get('/api/rooms/:roomId/messages', (req, res) => {
  const room = rooms.get(req.params.roomId.toUpperCase());
  if (!room) {
    return res.status(404).json({ success: false, error: 'Room not found' });
  }
  res.json({ success: true, count: room.messages.length, messages: room.messages });
});

// Update room video (API endpoint)
app.post('/api/rooms/:roomId/video', (req, res) => {
  const room = rooms.get(req.params.roomId.toUpperCase());
  if (!room) {
    return res.status(404).json({ success: false, error: 'Room not found' });
  }
  const { videoType, url, videoId, filename, action, time } = req.body;
  room.currentVideo = { 
    videoType, url, videoId, filename, action, time, 
    updatedAt: new Date().toISOString() 
  };

  io.to(req.params.roomId.toUpperCase()).emit('video-update', room.currentVideo);
  res.json({ success: true, video: room.currentVideo });
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({ 
    success: true, 
    status: 'running', 
    activeRooms: rooms.size,
    uptime: process.uptime()
  });
});

// ==================== Socket.io Realtime ====================
io.on('connection', (socket) => {
  let currentRoom = null;
  let currentUser = null;

  // Join Room
  socket.on('join-room', ({ roomId, username }, callback) => {
    if (!roomId || !username) {
      return callback?.({ success: false, error: 'ناو و کۆدی ڕوم پێویستە' });
    }

    const roomCode = roomId.toUpperCase().trim();

    // Create room if not exists
    if (!rooms.has(roomCode)) {
      rooms.set(roomCode, {
        users: [],
        messages: [],
        createdAt: new Date().toISOString(),
        currentVideo: null,
        hostId: socket.id
      });
    }

    const room = rooms.get(roomCode);

    // Check room capacity (max 5)
    if (room.users.length >= 5) {
      return callback?.({ success: false, error: 'ئەم ڕومە پڕە! (زۆرترین ٥ کەس)' });
    }

    // Check duplicate username
    if (room.users.find(u => u.name.toLowerCase() === username.toLowerCase())) {
      return callback?.({ success: false, error: 'ئەم ناوە پێشتر بەکارهاتووە لە ڕومەکەدا' });
    }

    socket.join(roomCode);
    currentRoom = roomCode;
    currentUser = username;

    const isHost = room.users.length === 0;
    if (isHost) room.hostId = socket.id;

    const userData = {
      id: socket.id,
      name: username,
      isHost,
      joinedAt: new Date().toISOString(),
      muted: true
    };

    room.users.push(userData);

    // Notify others in room
    socket.to(roomCode).emit('user-joined', {
      userId: socket.id,
      name: username,
      isHost,
      users: room.users
    });

    // Send room state back to new user
    callback?.({
      success: true,
      isHost,
      users: room.users,
      currentVideo: room.currentVideo,
      messages: room.messages.slice(-50) // Last 50 messages
    });

    console.log(`[+] ${username} joined room ${roomCode}`);
  });

  // ==================== WebRTC Signaling ====================
  socket.on('webrtc-offer', ({ targetId, offer }) => {
    io.to(targetId).emit('webrtc-offer', {
      fromId: socket.id,
      fromName: currentUser,
      offer
    });
  });

  socket.on('webrtc-answer', ({ targetId, answer }) => {
    io.to(targetId).emit('webrtc-answer', {
      fromId: socket.id,
      answer
    });
  });

  socket.on('webrtc-ice-candidate', ({ targetId, candidate }) => {
    io.to(targetId).emit('webrtc-ice-candidate', {
      fromId: socket.id,
      candidate
    });
  });

  // ==================== Chat ====================
  socket.on('chat-message', ({ text }) => {
    if (!currentRoom || !currentUser) return;

    const room = rooms.get(currentRoom);
    const message = {
      id: Date.now().toString(36),
      user: currentUser,
      text: text.substring(0, 500), // Limit message length
      time: new Date().toISOString()
    };

    room.messages.push(message);
    if (room.messages.length > 100) room.messages.shift();

    io.to(currentRoom).emit('chat-message', message);
  });

  // ==================== Video Sync ====================
  socket.on('video-action', ({ action, data }) => {
    if (!currentRoom) return;
    socket.to(currentRoom).emit('video-action', {
      action, // play, pause, seek, load
      data,
      from: currentUser,
      fromId: socket.id
    });
  });

  // ==================== Mic & Speaking Status ====================
  socket.on('mic-status', ({ isOn }) => {
    if (!currentRoom) return;
    const room = rooms.get(currentRoom);
    const user = room?.users.find(u => u.id === socket.id);
    if (user) user.muted = !isOn;

    socket.to(currentRoom).emit('mic-status', {
      userId: socket.id,
      userName: currentUser,
      isOn
    });
  });

  socket.on('speaking-status', ({ isSpeaking }) => {
    if (!currentRoom) return;
    socket.to(currentRoom).emit('speaking-status', {
      userId: socket.id,
      userName: currentUser,
      isSpeaking
    });
  });

  // ==================== Disconnect ====================
  socket.on('disconnect', () => {
    if (currentRoom && rooms.has(currentRoom)) {
      const room = rooms.get(currentRoom);
      room.users = room.users.filter(u => u.id !== socket.id);

      if (room.users.length === 0) {
        // Delete empty room after 2 minutes
        setTimeout(() => {
          if (rooms.has(currentRoom) && rooms.get(currentRoom).users.length === 0) {
            rooms.delete(currentRoom);
            console.log(`[x] Room ${currentRoom} deleted (empty)`);
          }
        }, 120000);
      } else {
        // Assign new host if host left
        if (room.hostId === socket.id && room.users.length > 0) {
          room.hostId = room.users[0].id;
          room.users[0].isHost = true;
        }

        io.to(currentRoom).emit('user-left', {
          userId: socket.id,
          userName: currentUser,
          users: room.users
        });
      }
      console.log(`[-] ${currentUser} left room ${currentRoom}`);
    }
  });
});

// ==================== Start Server ====================
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`🎬 Film Server running on port ${PORT}`);
  console.log(`📁 API Endpoints:`);
  console.log(`   GET  /api/health`);
  console.log(`   GET  /api/rooms`);
  console.log(`   GET  /api/rooms/:roomId`);
  console.log(`   GET  /api/rooms/:roomId/messages`);
  console.log(`   POST /api/rooms/:roomId/video`);
});