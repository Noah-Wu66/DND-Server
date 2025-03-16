const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const morgan = require('morgan');
const mongoose = require('mongoose');
require('dotenv').config();

const battlesRoutes = require('./routes/battles');
const diceRoutes = require('./routes/dice'); // 骰子路由
const battlefieldRoutes = require('./routes/battlefield'); // 新增战场路由
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
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
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
app.use('/api/v1/battlefield', battlefieldRoutes); // 新增战场API路由

// 存储骰子会话历史记录的内存缓存
const diceSessionHistory = {};

// 存储分块图片的缓存
const imageChunks = {};

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
  
  // 战场相关事件
  socket.on('join-battlefield', (sessionId) => {
    console.log(`Client ${socket.id} joined battlefield session: ${sessionId}`);
    socket.join(sessionId);
  });
  
  socket.on('move-piece', (data) => {
    if (data && data.sessionId && data.pieceId && data.x !== undefined && data.y !== undefined) {
      console.log(`Piece moved in ${data.sessionId}: ${data.pieceId}`);
      socket.to(data.sessionId).emit('piece-moved', {
        pieceId: data.pieceId,
        x: data.x,
        y: data.y
      });
    }
  });
  
  socket.on('update-background', (data) => {
    if (data && data.sessionId && data.imageUrl) {
      console.log(`Background updated in ${data.sessionId}`);
      socket.to(data.sessionId).emit('background-updated', {
        imageUrl: data.imageUrl
      });
    }
  });
  
  socket.on('update-grid-visibility', (data) => {
    if (data && data.sessionId && data.isVisible !== undefined) {
      console.log(`Grid visibility updated in ${data.sessionId}: ${data.isVisible}`);
      socket.to(data.sessionId).emit('grid-visibility-updated', {
        isVisible: data.isVisible
      });
    }
  });
  
  socket.on('update-piece-size', (data) => {
    if (data && data.sessionId && data.size !== undefined) {
      console.log(`Piece size updated in ${data.sessionId}: ${data.size}`);
      socket.to(data.sessionId).emit('piece-size-updated', {
        size: data.size
      });
    }
  });
  
  socket.on('update-scale', (data) => {
    if (data && data.sessionId && data.scale !== undefined) {
      console.log(`Scale updated in ${data.sessionId}: ${data.scale}`);
      socket.to(data.sessionId).emit('scale-updated', {
        scale: data.scale
      });
    }
  });
  
  socket.on('battlefield-settings-updated', (data) => {
    if (data && data.sessionId && data.settings) {
      console.log(`Battlefield settings updated in ${data.sessionId}`);
      socket.to(data.sessionId).emit('battlefield-settings-updated', data.settings);
    }
  });
  
  socket.on('battlefield-state-updated', (data) => {
    if (data && data.sessionId && data.state) {
      console.log(`Battlefield state updated in ${data.sessionId}`);
      socket.to(data.sessionId).emit('battlefield-state-updated', {
        state: data.state
      });
    }
  });
  
  // 请求战场状态处理
  socket.on('get-battlefield-state', (data) => {
    if (data && data.sessionId) {
      console.log(`Client ${socket.id} requested battlefield state for session: ${data.sessionId}`);
      
      // 从数据库获取状态并发送
      const Battlefield = require('./models/battlefield');
      Battlefield.findOne({ sessionId: data.sessionId })
        .then(battlefield => {
          if (battlefield) {
            // 转换为客户端期望的格式
            const clientState = {
              isGridVisible: battlefield.settings.gridVisible,
              pieceSize: battlefield.settings.pieceSize,
              pieces: {}
            };
            
            // 添加背景图片
            if (battlefield.background && battlefield.background.imageUrl) {
              clientState.backgroundImage = battlefield.background.imageUrl;
            }
            
            // 转换棋子数据 - 从Map转换为对象
            Array.from(battlefield.pieces.entries()).forEach(([id, piece]) => {
              clientState.pieces[id] = {
                x: piece.x || 0,
                y: piece.y || 0,
                name: piece.name || "",
                type: piece.type || "monster",
                currentHp: piece.currentHp || 0,
                maxHp: piece.maxHp || 0
              };
            });
            
            socket.emit('battlefield-state', {
              state: clientState
            });
          }
        })
        .catch(err => console.error('Error getting battlefield state:', err));
    }
  });
  
  // 分块图片传输处理
  socket.on('background-transfer-start', (data) => {
    if (data && data.sessionId && data.imageId && data.totalChunks) {
      console.log(`Background transfer started in ${data.sessionId}, image ID: ${data.imageId}, total chunks: ${data.totalChunks}`);
      
      // 初始化图片块数据结构
      imageChunks[data.imageId] = {
        chunks: new Array(data.totalChunks),
        received: 0,
        total: data.totalChunks,
        sessionId: data.sessionId
      };
    }
  });
  
  socket.on('background-transfer-chunk', (data) => {
    if (data && data.sessionId && data.imageId && data.chunk && data.chunkIndex !== undefined) {
      const imageData = imageChunks[data.imageId];
      
      if (!imageData) {
        console.error(`Received chunk for unknown image ID: ${data.imageId}`);
        return;
      }
      
      // 保存图片块
      imageData.chunks[data.chunkIndex] = data.chunk;
      imageData.received++;
      
      console.log(`Received chunk ${data.chunkIndex + 1}/${imageData.total} for image ${data.imageId}`);
      
      // 检查是否所有块都已接收
      if (data.isLastChunk || imageData.received === imageData.total) {
        console.log(`All chunks received for image ${data.imageId}, assembling...`);
        
        // 组装完整图片
        const fullImage = imageData.chunks.join("");
        
        // 发送完整图片给所有客户端
        socket.to(data.sessionId).emit('background-transfer-complete', {
          imageUrl: fullImage
        });
        
        // 清理内存
        delete imageChunks[data.imageId];
      }
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
