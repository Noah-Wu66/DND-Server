const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const morgan = require('morgan');
const mongoose = require('mongoose'); // <--- 恢复 mongoose
const axios = require('axios');
// const fs = require('fs'); // <--- 移除 fs 模块 (不再使用)
// const path = require('path'); // <--- 移除 path 模块 (不再使用)
require('dotenv').config();

// --- 恢复数据库连接和模型 ---
const connectDB = require('./config/database'); // <--- 恢复数据库连接
const Session = require('./models/session'); // <--- 恢复 Session 模型
const DiceSession = require('./models/diceSession'); // <--- 恢复 DiceSession 模型
const Battlefield = require('./models/battlefield'); // <--- 恢复 Battlefield 模型
// const errorHandler = require('./middlewares/errorHandler');

// 初始化应用
const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: process.env.CORS_ORIGIN || '*',
    methods: ['GET', 'POST']
  }
});

// 连接数据库
connectDB(); // <--- 启用数据库连接

// 中间件
app.use(cors({
  origin: process.env.CORS_ORIGIN || '*'
}));
app.use(express.json({ limit: '50mb' })); // 限制需要增大以处理可能的 base64 背景
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(morgan('dev'));

// 健康检查路由
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    service: 'DnD Battle Assistant API',
    version: '1.0.3' // 版本更新 (MongoDB 持久化)
  });
});

// 代理路由 (保持不变)
app.use('/proxy/dnd-database', async (req, res) => {
    try {
      const targetUrl = `https://dnd-database.zeabur.app${req.url}`;
      console.log(`Proxying request to: ${targetUrl}`);
      
      const method = req.method.toLowerCase();
      const requestOptions = {
        method,
        url: targetUrl,
        headers: {
          // 转发大部分头部，但 host 可能需要修改
          ...req.headers,
          host: 'dnd-database.zeabur.app', // 确保 host 正确
          // 可能需要移除或修改其他与代理冲突的头部，如 'content-length'
        },
      };
      
      // 对于POST, PUT等方法，需要转发请求体
      if (['post', 'put', 'patch'].includes(method) && req.body) {
        requestOptions.data = req.body;
      }
      
      // 如果有查询参数
      if (Object.keys(req.query).length > 0) {
        requestOptions.params = req.query;
      }
      
      const response = await axios(requestOptions);
      
      // 返回数据
      res.status(response.status).json(response.data);
    } catch (error) {
      console.error('代理请求错误:', error.message);
      
      // 如果错误中包含响应对象，则使用该响应的状态码
      if (error.response) {
        res.status(error.response.status).json({
          error: '代理请求失败',
          details: error.response.data
        });
      } else {
        res.status(500).json({
          error: '代理请求失败',
          message: error.message
        });
      }
    }
});


// -------------------- 内存状态管理 & MongoDB 持久化 --------------------
let sessions = {}; // 内存缓存
let diceSessions = {}; // 内存缓存
let battlefieldSessions = {}; // 内存缓存
const backgroundChunks = {};

// --- 修改: 从 MongoDB 加载数据 ---
async function loadDataOnStartup() {
    console.log("Loading session data from MongoDB...");
    try {
        const [loadedSessions, loadedDiceSessions, loadedBattlefields] = await Promise.all([
            Session.find({}).lean(), // .lean() 返回普通 JS 对象，更快
            DiceSession.find({}).lean(),
            Battlefield.find({}).lean()
        ]);

        sessions = loadedSessions.reduce((acc, doc) => {
            acc[doc.sessionId] = {
                 monsters: doc.monsters || {},
                 monsterOrder: doc.monsterOrder || [],
                 lastUpdated: doc.lastUpdated || Date.now()
             };
            return acc;
        }, {});

        diceSessions = loadedDiceSessions.reduce((acc, doc) => {
            acc[doc.sessionId] = {
                 diceState: doc.diceState || { dice: {}, advantage: false, disadvantage: false },
                 rollHistory: doc.rollHistory || [],
                 lastUpdated: doc.lastUpdated || Date.now()
             };
            return acc;
        }, {});

        // Battlefield pieces 在 Schema 中是数组，内存中用对象，需要转换
        battlefieldSessions = loadedBattlefields.reduce((acc, doc) => {
             const piecesObject = (doc.pieces || []).reduce((pieceAcc, piece) => {
                 if (piece && piece.id) {
                     pieceAcc[piece.id] = piece;
                 }
                 return pieceAcc;
             }, {});

            acc[doc.sessionId] = {
                 pieces: piecesObject,
                 backgroundImage: doc.background ? doc.background.imageUrl : null,
                 scale: doc.settings ? doc.settings.scale : 1.0,
                 isGridVisible: doc.settings ? doc.settings.gridVisible : true,
                 pieceSize: doc.settings ? doc.settings.pieceSize : 40,
                 lastUpdated: doc.lastUpdated || Date.now()
             };
            return acc;
        }, {});

        console.log(`Loaded state counts from DB: Battle=${Object.keys(sessions).length}, Dice=${Object.keys(diceSessions).length}, Battlefield=${Object.keys(battlefieldSessions).length}`);

    } catch (error) {
        console.error("Error loading data from MongoDB:", error);
        // 如果加载失败，保持内存为空对象
        sessions = {};
        diceSessions = {};
        battlefieldSessions = {};
    }
}

// --- 修改: 将内存数据保存到 MongoDB ---
async function persistSessionData(sessionId) {
    try {
        const sessionData = sessions[sessionId];
        if (sessionData) {
             await Session.findOneAndUpdate(
                 { sessionId: sessionId },
                 { $set: { monsters: sessionData.monsters, monsterOrder: sessionData.monsterOrder, lastUpdated: sessionData.lastUpdated } },
                 { upsert: true, new: true } // new: true 可能不需要，upsert 会创建
             );
        }
        const diceData = diceSessions[sessionId];
        if (diceData) {
             await DiceSession.findOneAndUpdate(
                 { sessionId: sessionId },
                 { $set: { diceState: diceData.diceState, rollHistory: diceData.rollHistory, lastUpdated: diceData.lastUpdated } },
                 { upsert: true }
             );
        }
        const battlefieldData = battlefieldSessions[sessionId];
        if (battlefieldData) {
             // 将 pieces 对象转换回 Schema 定义的数组格式
             const piecesArray = Object.values(battlefieldData.pieces || {});
             await Battlefield.findOneAndUpdate(
                 { sessionId: sessionId },
                 { $set: {
                     pieces: piecesArray,
                     'settings.scale': battlefieldData.scale,
                     'settings.gridVisible': battlefieldData.isGridVisible,
                     'settings.pieceSize': battlefieldData.pieceSize,
                     'background.imageUrl': battlefieldData.backgroundImage,
                     'background.lastUpdated': battlefieldData.backgroundImage ? Date.now() : undefined, // 更新背景时更新时间
                     lastUpdated: battlefieldData.lastUpdated
                 }},
                 { upsert: true }
             );
        }
        // console.log(`Persisted data for session ${sessionId} to MongoDB.`); // 调试信息
    } catch (error) {
        console.error(`Error persisting data for session ${sessionId} to MongoDB:`, error);
    }
}

// Helper function to get or initialize session data
function getSession(sessionId) {
    if (!sessions[sessionId]) {
        console.log(`Initializing new battle session in memory: ${sessionId}`);
        sessions[sessionId] = { monsters: {}, monsterOrder: [], lastUpdated: Date.now() };
    }
    return sessions[sessionId];
}

function getDiceSession(sessionId) {
    if (!diceSessions[sessionId]) {
        console.log(`Initializing new dice session in memory: ${sessionId}`);
        diceSessions[sessionId] = {
            diceState: { dice: { d4: 0, d6: 0, d8: 0, d10: 0, d12: 0, d20: 0 }, advantage: false, disadvantage: false },
            rollHistory: [],
            lastUpdated: Date.now()
        };
    }
    return diceSessions[sessionId];
}

function getBattlefieldSession(sessionId) {
    if (!battlefieldSessions[sessionId]) {
        console.log(`Initializing new battlefield session in memory: ${sessionId}`);
        battlefieldSessions[sessionId] = {
            pieces: {},
            backgroundImage: null,
            scale: 1.0,
            isGridVisible: true,
            pieceSize: 40,
            lastUpdated: Date.now()
        };
    }
    return battlefieldSessions[sessionId];
}
// -----------------------------------------------------


// WebSocket处理
io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);
  let currentSessionId = null; // 跟踪此 socket 加入的会话 ID

  // --- 通用加入会话逻辑 ---
  socket.on('join-session', (sessionId) => {
    if (!sessionId) {
        console.warn(`Client ${socket.id} attempted to join without sessionId`);
        return;
    }
    console.log(`Client ${socket.id} joining session: ${sessionId}`);
    socket.join(sessionId);
    currentSessionId = sessionId; // 记录当前会话ID

    // --- 发送当前状态给新加入者 ---
    // 确保在访问前初始化会话
    const sessionData = getSession(sessionId);
    console.log(`Emitting initial session-updated to ${socket.id} for ${sessionId}`);
    socket.emit('session-updated', sessionData); // 发送战斗状态

    const diceData = getDiceSession(sessionId);
    console.log(`Emitting initial dice-state-updated and roll-history-sync to ${socket.id} for ${sessionId}`);
    socket.emit('dice-state-updated', diceData.diceState); // 发送骰子状态
    socket.emit('roll-history-sync', diceData.rollHistory); // 发送骰子历史

    const battlefieldData = getBattlefieldSession(sessionId);
     // 确保发送的 battlefield 数据结构与客户端 loadBattlefieldState 期望的一致
     console.log(`Emitting initial battlefield-state-updated to ${socket.id} for ${sessionId}`);
    socket.emit('battlefield-state-updated', { state: battlefieldData }); // 发送战场状态
  });

  // --- 状态请求处理 ---
  socket.on('request-latest-state', (data) => {
     if (!data || !data.sessionId) return;
     console.log(`Received request-latest-state for ${data.sessionId} from ${socket.id}`);
     const sessionData = getSession(data.sessionId);
     socket.emit('session-updated', sessionData);
  });

  socket.on('request-latest-dice-state', (data) => {
      if (!data || !data.sessionId) return;
      console.log(`Received request-latest-dice-state for ${data.sessionId} from ${socket.id}`);
      const diceData = getDiceSession(data.sessionId);
      socket.emit('dice-state-updated', diceData.diceState);
      socket.emit('roll-history-sync', diceData.rollHistory);
  });

  socket.on('request-latest-battlefield-state', (data) => {
      if (!data || !data.sessionId) return;
      console.log(`Received request-latest-battlefield-state for ${data.sessionId} from ${socket.id}`);
      const battlefieldData = getBattlefieldSession(data.sessionId);
      socket.emit('battlefield-state-updated', { state: battlefieldData });
  });


  // --- 战斗助手事件处理 ---
  socket.on('add-monster', (data) => {
      if (!data || !data.sessionId || !data.monster || !data.monster.id) {
         console.warn("Received invalid add-monster data:", data);
         return;
      }
      const { sessionId, monster } = data;
      console.log(`Adding monster ${monster.id} to session ${sessionId}`);
      const session = getSession(sessionId);
      const battlefield = getBattlefieldSession(sessionId); // <--- 获取战场会话

      const newMonsterData = { // 确保存储的数据结构完整
          id: monster.id,
          name: monster.name || 'Unnamed Monster',
          type: monster.type || 'monster',
          currentHp: monster.currentHp || 0,
          maxHp: monster.maxHp || 100,
          tempHp: monster.tempHp || 0,
          conditions: monster.conditions || '[]',
          isLocked: monster.isLocked || false
      };
      session.monsters[monster.id] = newMonsterData;

      if (!session.monsterOrder.includes(monster.id)) {
          session.monsterOrder.push(monster.id);
      }
      session.lastUpdated = Date.now();

      // --- 添加: 同时更新战场状态 --- 
      if (!battlefield.pieces[monster.id]) {
          console.log(`Adding piece ${monster.id} to battlefield session ${sessionId}`);
          // 使用怪物的基本信息，并给一个默认位置
          const pieceCount = Object.keys(battlefield.pieces).length;
          battlefield.pieces[monster.id] = {
               id: monster.id,
               x: 50 + (pieceCount % 10) * 50, // 简单的默认位置逻辑
               y: 50 + Math.floor(pieceCount / 10) * 50,
               name: newMonsterData.name,
               type: newMonsterData.type,
               currentHp: newMonsterData.currentHp,
               maxHp: newMonsterData.maxHp
          };
          battlefield.lastUpdated = Date.now(); // 更新战场时间戳
      }
      // --- 结束添加 ---

      // 广播 monster-updated 给所有客户端
      io.to(sessionId).emit('monster-updated', session.monsters[monster.id]);
      // 广播更新后的顺序
      io.to(sessionId).emit('monsters-reordered', { order: session.monsterOrder });
      // --- 添加: 广播更新后的战场状态 --- 
      io.to(sessionId).emit('battlefield-state-updated', { state: battlefield });
      // --- 结束添加 ---

      console.log(`Monster ${monster.id} added. Current monsters:`, Object.keys(session.monsters));
      persistSessionData(sessionId).catch(err => console.error("Async persist error (add-monster):", err));
  });

  socket.on('update-hp', (data) => {
      if (!data || !data.sessionId || !data.monsterId || data.currentHp === undefined || data.maxHp === undefined) {
           console.warn("Received invalid update-hp data:", data);
           return;
       }
      const { sessionId, monsterId, currentHp, maxHp, tempHp } = data;
      console.log(`Updating HP for ${monsterId} in ${sessionId}: cur=${currentHp}, max=${maxHp}, temp=${tempHp}`);
      const session = getSession(sessionId);
      if (session.monsters[monsterId]) {
          session.monsters[monsterId].currentHp = currentHp;
          session.monsters[monsterId].maxHp = maxHp;
          session.monsters[monsterId].tempHp = tempHp === undefined ? session.monsters[monsterId].tempHp : tempHp; // 保留之前的 tempHp 如果没提供
          session.lastUpdated = Date.now();
          // 广播 monster-updated 包含所有怪物信息
          io.to(sessionId).emit('monster-updated', session.monsters[monsterId]);
          persistSessionData(sessionId).catch(err => console.error("Async persist error (update-hp):", err)); // <--- 添加异步保存
      } else {
          console.warn(`Monster ${monsterId} not found in session ${sessionId} for HP update.`);
      }
  });

  socket.on('update-name', (data) => {
    if (!data || !data.sessionId || !data.monsterId || data.name === undefined) {
        console.warn("Received invalid update-name data:", data);
        return;
    }
    const { sessionId, monsterId, name } = data;
    console.log(`Updating name for ${monsterId} in ${sessionId} to "${name}"`);
    const session = getSession(sessionId);
    if (session.monsters[monsterId]) {
        session.monsters[monsterId].name = name;
        session.lastUpdated = Date.now();
        // 广播 monster-updated
        io.to(sessionId).emit('monster-updated', session.monsters[monsterId]);
        persistSessionData(sessionId).catch(err => console.error("Async persist error (update-name):", err)); // <--- 添加异步保存
    } else {
         console.warn(`Monster ${monsterId} not found in session ${sessionId} for name update.`);
    }
  });

  // 处理前端发送的批量删除请求
  socket.on('batch-delete-monsters', (data) => {
     if (!data || !data.sessionId || !Array.isArray(data.monsterIds)) {
         console.warn("Received invalid batch-delete-monsters data:", data);
         return;
     }
     const { sessionId, monsterIds } = data;
     console.log(`Batch deleting monsters in ${sessionId}:`, monsterIds);
     const session = getSession(sessionId);
     const battlefield = getBattlefieldSession(sessionId); // 同时更新战场
     let changed = false;
     const deletedIds = []; // 记录实际删除的 ID

     monsterIds.forEach(id => {
         if (session.monsters[id]) {
             delete session.monsters[id];
             deletedIds.push(id);
             changed = true;
         }
         // 从战场棋子中删除
         if (battlefield.pieces[id]) {
             delete battlefield.pieces[id];
             changed = true; // 标记战场也已改变
         }
         const index = session.monsterOrder.indexOf(id);
         if (index > -1) {
             session.monsterOrder.splice(index, 1);
             changed = true;
         }
     });

     if (changed) {
         session.lastUpdated = Date.now();
         battlefield.lastUpdated = Date.now(); // 更新战场时间戳
         // 广播精确的删除事件给客户端
         io.to(sessionId).emit('monsters-deleted', { monsterIds: deletedIds });
         // 广播更新后的顺序
         io.to(sessionId).emit('monsters-reordered', { order: session.monsterOrder });
         // 广播更新后的战场状态
         io.to(sessionId).emit('battlefield-state-updated', { state: battlefield });

         persistSessionData(sessionId).catch(err => console.error("Async persist error (batch-delete):", err)); // <--- 添加异步保存
         console.log(`Monsters deleted. Remaining:`, Object.keys(session.monsters));
         console.log(`Battlefield pieces after deletion:`, Object.keys(battlefield.pieces));
     }
  });

   // 处理前端发送的重新排序请求
   socket.on('reorder-monsters', (data) => {
     if (!data || !data.sessionId || !Array.isArray(data.order)) {
        console.warn("Received invalid reorder-monsters data:", data);
        return;
     }
     const { sessionId, order } = data;
     console.log(`Reordering monsters in ${sessionId}`);
     const session = getSession(sessionId);
     session.monsterOrder = order;
     session.lastUpdated = Date.now();
     // 直接广播新的顺序给所有客户端
     io.to(sessionId).emit('monsters-reordered', { order: session.monsterOrder });
     persistSessionData(sessionId).catch(err => console.error("Async persist error (reorder):", err)); // <--- 添加异步保存
   });

  // --- 骰子事件处理 ---
  socket.on('update-dice-state', (data) => {
    if (!data || !data.sessionId || !data.diceState) {
         console.warn("Received invalid update-dice-state data:", data);
         return;
    }
    const { sessionId, diceState, playerName } = data; // playerName 可选，用于日志
    console.log(`Dice state update in ${sessionId} from ${playerName || socket.id}`);
    const diceSession = getDiceSession(sessionId);
    diceSession.diceState = diceState;
    diceSession.lastUpdated = Date.now();
    // 广播给其他客户端 (不包括发送者)
    socket.to(sessionId).emit('dice-state-updated', diceSession.diceState);
    persistSessionData(sessionId).catch(err => console.error("Async persist error (update-dice-state):", err)); // <--- 添加异步保存
  });

  socket.on('roll-dice', (data) => {
     if (!data || !data.sessionId || !data.playerName || !data.diceConfig || !data.diceConfig.dice) {
          console.warn("Received invalid roll-dice data:", data);
          return;
      }
     const { sessionId, playerName, diceConfig } = data;
     console.log(`Dice roll requested in ${sessionId} by ${playerName}`, diceConfig);

     // --- 在服务器端执行投掷逻辑 ---
     const rollResults = {};
     let grandTotal = 0;
     const now = Date.now();

     for (const diceType in diceConfig.dice) {
         const quantity = parseInt(diceConfig.dice[diceType]); // 确保是数字
         if (quantity > 0 && diceType.match(/^d(4|6|8|10|12|20)$/)) { // 验证骰子类型
             rollResults[diceType] = { quantity: quantity, rolls: [], subtotal: 0 };
             const faces = parseInt(diceType.substring(1));
             for (let i = 0; i < quantity; i++) {
                 if (diceConfig.advantage || diceConfig.disadvantage) {
                     const roll1 = Math.floor(Math.random() * faces) + 1;
                     const roll2 = Math.floor(Math.random() * faces) + 1;
                     const finalRoll = diceConfig.advantage ? Math.max(roll1, roll2) : Math.min(roll1, roll2);
                     rollResults[diceType].rolls.push({ roll1, roll2, finalRoll, isAdvantage: diceConfig.advantage, isDisadvantage: diceConfig.disadvantage });
                     rollResults[diceType].subtotal += finalRoll;
                 } else {
                     const roll = Math.floor(Math.random() * faces) + 1;
                     rollResults[diceType].rolls.push(roll);
                     rollResults[diceType].subtotal += roll;
                 }
             }
             grandTotal += rollResults[diceType].subtotal;
         }
     }

     // 确保即使没有有效骰子也有时间戳和玩家名
     const rollDataToSend = {
         playerName: playerName,
         rolls: rollResults, // 可能为空对象 {}
         grandTotal: grandTotal,
         timestamp: now
     };
     // --- 投掷逻辑结束 ---


     const diceSession = getDiceSession(sessionId);
     // 添加到历史记录
     if (diceSession.rollHistory.length >= 50) { // 增加历史记录容量
        diceSession.rollHistory.shift();
     }
     diceSession.rollHistory.push(rollDataToSend);
     diceSession.lastUpdated = now;

     // 广播投掷结果给所有客户端
     console.log(`Broadcasting dice roll result for ${sessionId}:`, rollDataToSend);
     io.to(sessionId).emit('dice-rolled', rollDataToSend);
     persistSessionData(sessionId).catch(err => console.error("Async persist error (roll-dice):", err)); // <--- 添加异步保存
  });

  // 处理前端发送的重置请求
  socket.on('reset-dice-request', (data) => {
     if (!data || !data.sessionId || !data.playerName) {
          console.warn("Received invalid reset-dice-request data:", data);
          return;
      }
     const { sessionId, playerName } = data;
     console.log(`Dice reset requested in ${sessionId} by ${playerName}`);
     const diceSession = getDiceSession(sessionId);
     // 清空历史记录
     diceSession.rollHistory = [];
     // 重置骰子状态为初始值
     diceSession.diceState = { dice: { d4: 0, d6: 0, d8: 0, d10: 0, d12: 0, d20: 0 }, advantage: false, disadvantage: false };
     diceSession.lastUpdated = Date.now();

     // 广播重置事件给所有客户端
     io.to(sessionId).emit('reset-dice'); // 客户端收到后自行清空界面和历史
     // 广播重置后的状态
     io.to(sessionId).emit('dice-state-updated', diceSession.diceState);
     persistSessionData(sessionId).catch(err => console.error("Async persist error (reset-dice):", err)); // <--- 添加异步保存
  });


  // --- 战场事件处理 ---
  socket.on('move-piece', (data) => {
    if (!data || !data.sessionId || !data.pieceId || data.x === undefined || data.y === undefined) {
         console.warn("Received invalid move-piece data:", data);
         return;
     }
    const { sessionId, pieceId, x, y } = data;
    const battlefield = getBattlefieldSession(sessionId);
    let wasPieceNewlyCreated = false; // Flag to track if we created the piece here

    // 更新或添加棋子数据 (只更新位置)
    if (!battlefield.pieces[pieceId]) {
        // 如果棋子不存在，可能需要从主会话获取名称等信息来创建
        const session = getSession(sessionId);
        const monsterInfo = session.monsters[pieceId];
        if (monsterInfo) { // Only create if corresponding monster exists
            battlefield.pieces[pieceId] = {
                id: pieceId, // 确保有 id
                x: x,
                y: y,
                name: monsterInfo.name || "Unknown Piece",
                type: monsterInfo.type || "monster",
                currentHp: monsterInfo.currentHp || 0,
                maxHp: monsterInfo.maxHp || 0
            };
            console.log(`Piece ${pieceId} added to battlefield during move.`);
            wasPieceNewlyCreated = true; // Mark as newly created
        } else {
            console.warn(`Cannot move piece ${pieceId}: Corresponding monster not found in session ${sessionId}`);
            return; // Don't proceed if we can't create the piece
        }
    } else {
        // Just update position for existing piece
        battlefield.pieces[pieceId].x = x;
        battlefield.pieces[pieceId].y = y;
    }

    battlefield.lastUpdated = Date.now();

    // --- 修改广播逻辑 ---
    if (wasPieceNewlyCreated) {
        // If the piece was just created on the battlefield, broadcast the full state
        console.log(`Broadcasting full battlefield state update after creating piece ${pieceId} during move.`);
        io.to(sessionId).emit('battlefield-state-updated', { state: battlefield });
    } else {
        // Otherwise, just broadcast the move to other clients
        // console.log(`Broadcasting piece move for ${pieceId} in ${sessionId} to (${x}, ${y})`);
        socket.to(sessionId).emit('piece-moved', { pieceId, x, y });
    }
    // --- 结束修改广播逻辑 ---

    // Asynchronous persistence remains the same
    persistSessionData(sessionId).catch(err => console.error("Async persist error (move-piece):", err));
  });

  socket.on('update-background', (data) => {
     if (!data || !data.sessionId || data.imageUrl === undefined) { //允许空imageUrl清除背景
          console.warn("Received invalid update-background data:", data);
          return;
      }
     const { sessionId, imageUrl } = data;
     console.log(`Updating background for ${sessionId}`);
     const battlefield = getBattlefieldSession(sessionId);
     battlefield.backgroundImage = imageUrl; // imageUrl 可以是 base64 或 null/空字符串
     battlefield.lastUpdated = Date.now();
     // 广播给其他客户端
     socket.to(sessionId).emit('background-updated', { imageUrl });
     persistSessionData(sessionId).catch(err => console.error("Async persist error (update-background):", err)); // <--- 添加异步保存
  });

  // 处理分块背景图片上传
  socket.on('background-transfer-start', (data) => {
      if (!data || !data.sessionId || !data.imageId || !data.totalChunks) {
           console.warn("Received invalid background-transfer-start data:", data);
           return;
       }
      const { sessionId, imageId, totalChunks } = data;
      // 限制块数防止滥用
      if (totalChunks > 100) {
          console.warn(`Transfer for image ${imageId} rejected: too many chunks (${totalChunks})`);
          socket.emit('background-transfer-failed', { imageId, error: 'Too many chunks' });
          return;
      }
      console.log(`Starting background chunk transfer for ${sessionId}, imageId: ${imageId}, chunks: ${totalChunks}`);
      backgroundChunks[imageId] = {
          sessionId: sessionId,
          chunks: new Array(totalChunks),
          receivedChunks: 0,
          totalChunks: totalChunks,
          initiatorSocketId: socket.id, // <--- 记录发起者 ID
          timer: setTimeout(() => { // 添加超时清理
              console.warn(`Transfer for image ${imageId} timed out.`);
              if (backgroundChunks[imageId]) {
                  delete backgroundChunks[imageId];
                   io.to(sessionId).emit('background-transfer-failed', { imageId, error: 'Timeout' });
              }
          }, 60000) // 60秒超时
      };
  });

  socket.on('background-transfer-chunk', (data) => {
      if (!data || !data.sessionId || !data.imageId || data.chunkIndex === undefined || !data.chunk) {
           console.warn("Received invalid background-transfer-chunk data:", data);
           return;
       }
      const { sessionId, imageId, chunkIndex, chunk, isLastChunk } = data;

      const transfer = backgroundChunks[imageId];
      if (!transfer || transfer.sessionId !== sessionId) {
          console.warn(`Received chunk for unknown or mismatched transfer: ${imageId}, session: ${sessionId}`);
          return;
      }
       // 限制块大小
       if (chunk.length > 600 * 1024) { // 略大于前端的 512KB
            console.warn(`Chunk ${chunkIndex + 1}/${transfer.totalChunks} for image ${imageId} rejected: chunk too large`);
            clearTimeout(transfer.timer);
            delete backgroundChunks[imageId];
            io.to(sessionId).emit('background-transfer-failed', { imageId, error: 'Chunk too large' });
            return;
       }

      if (chunkIndex >= 0 && chunkIndex < transfer.totalChunks && !transfer.chunks[chunkIndex]) {
          transfer.chunks[chunkIndex] = chunk;
          transfer.receivedChunks++;
          // console.log(`Received chunk ${chunkIndex + 1}/${transfer.totalChunks} for image ${imageId} in session ${sessionId}`);

          // 重置超时计时器
          clearTimeout(transfer.timer);
          transfer.timer = setTimeout(() => {
               console.warn(`Transfer for image ${imageId} timed out after receiving chunk ${chunkIndex + 1}.`);
               if (backgroundChunks[imageId]) {
                  delete backgroundChunks[imageId];
                   io.to(sessionId).emit('background-transfer-failed', { imageId, error: 'Timeout' });
               }
          }, 60000); // 每次收到块后重置60秒超时

      } else if (transfer.chunks[chunkIndex]){
           console.log(`Received duplicate chunk ${chunkIndex + 1}/${transfer.totalChunks} for image ${imageId}`);
      } else {
           console.warn(`Received invalid chunk index ${chunkIndex} for image ${imageId}`);
            clearTimeout(transfer.timer);
            delete backgroundChunks[imageId];
            io.to(sessionId).emit('background-transfer-failed', { imageId, error: 'Invalid chunk index' });
           return;
      }


      // 检查是否所有块都已接收
      if (transfer.receivedChunks === transfer.totalChunks) {
          console.log(`All chunks received for image ${imageId} in session ${sessionId}. Reconstructing...`);
          clearTimeout(transfer.timer); // 清除最终的超时

          try {
              const fullImageUrl = transfer.chunks.join('');
              console.log(`Image reconstructed, size: ${Math.round(fullImageUrl.length / 1024)}KB`);

              // 再次检查图片大小是否过大 (防止恶意构造)
              if (fullImageUrl.length > 10 * 1024 * 1024) { // 限制最终大小为 10MB
                  console.warn(`Reconstructed image ${imageId} rejected: final size too large`);
                  io.to(sessionId).emit('background-transfer-failed', { imageId, error: 'Image too large after reconstruction' });
                  delete backgroundChunks[imageId];
                  return;
              }

              // 更新战场状态
              const battlefield = getBattlefieldSession(sessionId);
              battlefield.backgroundImage = fullImageUrl;
              battlefield.lastUpdated = Date.now();

              // 广播给所有客户端 (包括发送者，因为他们可能也需要确认)
              io.to(sessionId).emit('background-transfer-complete', { imageUrl: fullImageUrl });
              // 不再需要单独发送 background-updated，因为 complete 事件包含了 URL
              // io.to(sessionId).emit('background-updated', { imageUrl: fullImageUrl });

              persistSessionData(sessionId).catch(err => console.error("Async persist error (bg-transfer-complete):", err)); // <--- 添加异步保存

              // 清理内存
              delete backgroundChunks[imageId];

          } catch (error) {
               console.error(`Error reconstructing image ${imageId} for session ${sessionId}:`, error);
               // 通知客户端失败
               io.to(sessionId).emit('background-transfer-failed', { imageId, error: 'Reconstruction failed' });
               delete backgroundChunks[imageId];
          }
      }
  });


  socket.on('update-scale', (data) => {
      if (!data || !data.sessionId || data.scale === undefined) {
           console.warn("Received invalid update-scale data:", data);
           return;
       }
      const { sessionId, scale } = data;
      const validatedScale = Math.max(0.5, Math.min(3.0, Number(scale))); // 验证范围
      console.log(`Updating scale for ${sessionId} to ${validatedScale}`);
      const battlefield = getBattlefieldSession(sessionId);
      battlefield.scale = validatedScale;
      battlefield.lastUpdated = Date.now();
      socket.to(sessionId).emit('scale-updated', { scale: validatedScale });
      persistSessionData(sessionId).catch(err => console.error("Async persist error (update-scale):", err)); // <--- 添加异步保存
  });

  socket.on('update-grid-visibility', (data) => {
      if (!data || !data.sessionId || data.isVisible === undefined) {
           console.warn("Received invalid update-grid-visibility data:", data);
           return;
       }
      const { sessionId, isVisible } = data;
      const validatedIsVisible = Boolean(isVisible); // 转换为布尔值
      console.log(`Updating grid visibility for ${sessionId} to ${validatedIsVisible}`);
      const battlefield = getBattlefieldSession(sessionId);
      battlefield.isGridVisible = validatedIsVisible;
      battlefield.lastUpdated = Date.now();
      socket.to(sessionId).emit('grid-visibility-updated', { isVisible: validatedIsVisible });
      persistSessionData(sessionId).catch(err => console.error("Async persist error (update-grid):", err)); // <--- 添加异步保存
  });

  socket.on('update-piece-size', (data) => {
      if (!data || !data.sessionId || data.size === undefined) {
           console.warn("Received invalid update-piece-size data:", data);
           return;
       }
      const { sessionId, size } = data;
      const validatedSize = Math.max(20, Math.min(80, Number(size))); // 验证范围
      console.log(`Updating piece size for ${sessionId} to ${validatedSize}`);
      const battlefield = getBattlefieldSession(sessionId);
      battlefield.pieceSize = validatedSize;
      battlefield.lastUpdated = Date.now();
      socket.to(sessionId).emit('piece-size-updated', { size: validatedSize });
      persistSessionData(sessionId).catch(err => console.error("Async persist error (update-piece-size):", err)); // <--- 添加异步保存
  });


  // --- 断开连接 ---
  socket.on('disconnect', (reason) => {
    console.log(`Client disconnected: ${socket.id}, reason: ${reason}`);
    // 可选：处理用户离开会话的逻辑，例如通知其他人或清理资源
    // if (currentSessionId) {
    //     socket.to(currentSessionId).emit('user-left', { socketId: socket.id });
    // }
    // 清理可能未完成的背景传输
    Object.keys(backgroundChunks).forEach(imageId => {
        const transfer = backgroundChunks[imageId];
        // 简单起见，如果发起传输的 socket 断开，就删除传输记录
        // 更复杂的逻辑可以允许传输继续或由其他用户接管
        if (transfer.initiatorSocketId === socket.id) { // 需要在 start 时记录 initiatorSocketId
             console.log(`Cleaning up unfinished background transfer ${imageId} due to disconnect.`);
             clearTimeout(transfer.timer);
             delete backgroundChunks[imageId];
        }
    });
  });

});


// -------------------- API 路由 (可选, 仅用于GET或特殊操作) --------------------
// 如果需要保留 API 获取初始数据:
// const battlesRoutes = require('./routes/battles')(sessions); // 传递内存状态给路由
// app.use('/api/v1/battles', battlesRoutes);
// ... 其他路由类似 ...
// 注意：路由文件也需要修改以从内存读取而不是数据库
// --------------------------------------------------------

// 错误处理 (保持不变, 如果有定义 errorHandler)
// const errorHandler = require('./middlewares/errorHandler');
// app.use(errorHandler);

// --- 修改: 在启动服务器前加载数据 ---
async function startServer() {
    await loadDataOnStartup(); // 等待数据加载完成

    // 启动服务器
    const PORT = process.env.PORT || 3000;
    server.listen(PORT, () => {
      console.log(`Server running on port ${PORT}`);
    });
}

startServer(); // 调用异步启动函数

// -------------------- 定期/按需 持久化状态 (移除定时保存，改为事件触发) --------------------
// 优雅关闭时保存 (改为保存所有会话)
async function shutdown() {
    console.log('Shutting down. Saving all data before exit...');
    const allSessionIds = new Set([
        ...Object.keys(sessions),
        ...Object.keys(diceSessions),
        ...Object.keys(battlefieldSessions)
    ]);
    // 使用 Promise.all 来并行保存所有会话
    try {
        await Promise.all(Array.from(allSessionIds).map(id => persistSessionData(id)));
        console.log('All data persisted. Exiting.');
        process.exit(0);
    } catch (err) {
        console.error('Error persisting data during shutdown:', err);
        process.exit(1);
    }
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// 导出应用供测试使用
module.exports = { app, server, io };
