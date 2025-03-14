const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const morgan = require('morgan');
const mongoose = require('mongoose');
require('dotenv').config();

const battlesRoutes = require('./routes/battles');
const diceRoutes = require('./routes/dice'); // 骰子路由
const errorHandler = require('./middlewares/errorHandler');
const connectDB = require('./config/database');

// 初始化应用
const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: process.env.CORS_ORIGIN || '*',
    methods: ['GET', 'POST']
  }
});

// 将io实例保存到app中以便在路由中使用
app.set('io', io);

// 连接数据库
connectDB();

// 中间件
app.use(cors({
  origin: process.env.CORS_ORIGIN || '*'
}));
app.use(express.json());
app.use(morgan('dev'));

// 健康检查路由
app.get('/', (req, res) => {
  res.json({ 
    status: 'ok',
    service: 'DnD Battle Assistant API',
    version: '1.0.0' 
  });
});

// API路由
app.use('/api/v1/battles', battlesRoutes);
app.use('/api/v1/dice', diceRoutes); // 骰子API路由

// 存储骰子会话历史记录的内存缓存
const diceSessionHistory = {};

// WebSocket处理
io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);
  let joinedDiceSession = null;
  let playerName = null;
  
  // 战斗助手相关事件
  socket.on('join-session', (sessionId) => {
    console.log(`Client ${socket.id} joined battle session: ${sessionId}`);
    socket.join(sessionId);
  });
  
  socket.on('update-monster', (data) => {
    if (data && data.sessionId && data.monster) {
      console.log(`Monster update in ${data.sessionId}: ${data.monster.id}`);
      socket.to(data.sessionId).emit('monster-updated', data.monster);
    }
  });
  
  socket.on('delete-monster', (data) => {
    if (data && data.sessionId && data.monsterId) {
      console.log(`Monster deleted in ${data.sessionId}: ${data.monsterId}`);
      socket.to(data.sessionId).emit('delete-monster', {
        monsterId: data.monsterId
      });
    }
  });
  
  socket.on('session-update', (data) => {
    if (data && data.sessionId && data.data) {
      console.log(`Session update in ${data.sessionId}`);
      socket.to(data.sessionId).emit('session-updated', data.data);
    }
  });
  
  socket.on('reorder-monsters', (data) => {
    if (data && data.sessionId && data.order) {
      console.log(`Monster order update in ${data.sessionId}`);
      
      // 广播顺序更新事件给其他客户端
      socket.to(data.sessionId).emit('monsters-reordered', {
        order: data.order
      });
      
      // 更新数据库中的顺序
      const Session = require('./models/session');
      Session.findOneAndUpdate(
        { sessionId: data.sessionId },
        { monsterOrder: data.order, lastUpdated: Date.now() },
        { new: true }
      ).catch(err => console.error('Error updating monster order:', err));
    }
  });
  
  // 骰子模拟器相关事件 - 改进版
  socket.on('join-dice-session', (data) => {
    if (!data || !data.sessionId) return;
    
    joinedDiceSession = data.sessionId;
    playerName = data.playerName || "未知玩家";
    
    console.log(`Client ${socket.id} (${playerName}) joined dice session: ${joinedDiceSession}`);
    socket.join(joinedDiceSession);
    
    // 如果存在历史记录，发送给新加入的客户端
    if (diceSessionHistory[joinedDiceSession]) {
      socket.emit('roll-history-sync', diceSessionHistory[joinedDiceSession]);
    }
  });
  
  socket.on('update-dice-state', (data) => {
    if (data && data.sessionId && data.diceState) {
      console.log(`Dice state update in ${data.sessionId} by ${data.playerName || 'unknown'}`);
      socket.to(data.sessionId).emit('dice-state-updated', data.diceState);
    }
  });
  
  socket.on('roll-dice', (data) => {
    if (data && data.sessionId && data.rollData) {
      console.log(`Dice roll in ${data.sessionId} by ${data.rollData.playerName || 'unknown'}`);
      
      // 存储骰子结果到历史记录
      if (!diceSessionHistory[data.sessionId]) {
        diceSessionHistory[data.sessionId] = [];
      }
      
      // 限制历史记录大小
      if (diceSessionHistory[data.sessionId].length >= 20) {
        diceSessionHistory[data.sessionId].shift(); // 移除最旧的记录
      }
      
      diceSessionHistory[data.sessionId].push(data.rollData);
      
      // 广播骰子结果给其他玩家
      socket.to(data.sessionId).emit('dice-rolled', data.rollData);
    }
  });
  
  socket.on('reset-dice', (data) => {
    if (data && data.sessionId) {
      console.log(`Dice reset in ${data.sessionId} by ${data.playerName || 'unknown'}`);
      
      // 清空这个会话的历史记录
      if (diceSessionHistory[data.sessionId]) {
        diceSessionHistory[data.sessionId] = [];
      }
      
      // 广播重置事件给其他客户端
      socket.to(data.sessionId).emit('reset-dice');
    }
  });
  
  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
    joinedDiceSession = null;
  });
});

// 错误处理
app.use(errorHandler);

// 启动服务器
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

// 导出应用供测试使用
module.exports = { app, io };
