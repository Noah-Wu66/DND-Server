const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const Battlefield = require('../models/battlefield');

// 配置文件上传
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    const uploadDir = path.join(__dirname, '../uploads/battlefield');
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, file.fieldname + '-' + uniqueSuffix + path.extname(file.originalname));
  }
});

const upload = multer({
  storage: storage,
  limits: {
    fileSize: 5 * 1024 * 1024 // 限制5MB
  },
  fileFilter: function (req, file, cb) {
    const allowedTypes = ['image/jpeg', 'image/png', 'image/gif'];
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('不支持的文件类型'));
    }
  }
});

/**
 * @route   GET /api/v1/battlefield/sessions/:sessionId
 * @desc    获取战场状态
 * @access  Public
 */
router.get('/sessions/:sessionId', async (req, res, next) => {
  try {
    const { sessionId } = req.params;
    
    let battlefield = await Battlefield.findOne({ sessionId });
    
    // 如果战场不存在，创建新战场
    if (!battlefield) {
      battlefield = new Battlefield({
        sessionId,
        pieces: [],
        settings: {
          scale: 1.0,
          gridVisible: true,
          pieceSize: 40
        }
      });
      await battlefield.save();
    }
    
    // 返回战场数据
    res.json({
      success: true,
      data: {
        sessionId: battlefield.sessionId,
        settings: battlefield.settings,
        lastUpdated: battlefield.lastUpdated,
        pieces: battlefield.pieces || [],
        background: battlefield.background
      }
    });
    
  } catch (error) {
    console.error("获取战场数据出错:", error);
    next(error);
  }
});

/**
 * @route   POST /api/v1/battlefield/sessions/:sessionId
 * @desc    保存战场状态
 * @access  Public
 */
router.post('/sessions/:sessionId', async (req, res, next) => {
  try {
    const { sessionId } = req.params;
    const { pieces, settings, background } = req.body;
    
    console.log("接收到战场数据:", 
      `sessionId: ${sessionId}, ` +
      `pieces: ${pieces ? pieces.length : 0}, ` +
      `settings: ${settings ? '有设置数据' : '无设置数据'}, ` +
      `background: ${background ? '有背景' : '无背景'}`
    );
    
    // 构建更新数据对象
    const updateData = {
      lastUpdated: Date.now()
    };
    
    // 处理棋子数据 - 使用数组方式存储
    if (pieces && Array.isArray(pieces)) {
      updateData.pieces = pieces;
    }
    
    // 处理设置数据
    if (settings) {
      updateData.settings = {
        scale: settings.scale || 1.0,
        gridVisible: typeof settings.gridVisible === 'boolean' ? settings.gridVisible : true,
        pieceSize: settings.pieceSize || 40
      };
    }
    
    // 处理背景图片
    if (background && background.imageUrl) {
      updateData.background = {
        imageUrl: background.imageUrl,
        lastUpdated: Date.now()
      };
    }
    
    // 更新或创建战场
    const battlefield = await Battlefield.findOneAndUpdate(
      { sessionId },
      updateData,
      {
        new: true,
        upsert: true
      }
    );
    
    // 通过Socket.io通知其他客户端
    const io = req.app.get('io');
    if (io) {
      // 转换数据为客户端期望的格式
      const clientState = {
        isGridVisible: battlefield.settings.gridVisible,
        pieceSize: battlefield.settings.pieceSize,
        pieces: {}
      };
      
      // 添加背景图片
      if (battlefield.background && battlefield.background.imageUrl) {
        clientState.backgroundImage = battlefield.background.imageUrl;
      }
      
      // 转换棋子数据 - 从数组转换为对象
      if (Array.isArray(battlefield.pieces)) {
        battlefield.pieces.forEach(piece => {
          if (piece && piece.id) {
            clientState.pieces[piece.id] = {
              x: piece.x || 0,
              y: piece.y || 0,
              name: piece.name || "",
              type: piece.type || "monster",
              currentHp: piece.currentHp || 0,
              maxHp: piece.maxHp || 0
            };
          }
        });
      }
      
      io.to(sessionId).emit('battlefield-state-updated', {
        state: clientState
      });
    }
    
    res.json({
      success: true,
      data: {
        sessionId: battlefield.sessionId,
        lastUpdated: battlefield.lastUpdated
      }
    });
    
  } catch (error) {
    console.error("保存战场数据出错:", error);
    next(error);
  }
});

/**
 * @route   POST /api/v1/battlefield/sessions/:sessionId/background
 * @desc    上传战场背景图片
 * @access  Public
 */
router.post('/sessions/:sessionId/background', upload.single('background'), async (req, res, next) => {
  try {
    const { sessionId } = req.params;
    
    if (!req.file) {
      return res.status(400).json({
        success: false,
        error: '没有上传文件'
      });
    }
    
    // 构建图片URL
    const imageUrl = `/uploads/battlefield/${req.file.filename}`;
    
    // 更新战场背景
    const battlefield = await Battlefield.findOneAndUpdate(
      { sessionId },
      {
        background: {
          imageUrl,
          lastUpdated: Date.now()
        },
        lastUpdated: Date.now()
      },
      { new: true }
    );
    
    if (!battlefield) {
      return res.status(404).json({
        success: false,
        error: '找不到战场'
      });
    }
    
    // 通过Socket.io通知其他客户端
    req.app.get('io')?.to(sessionId).emit('background-updated', {
      imageUrl: battlefield.background.imageUrl
    });
    
    res.json({
      success: true,
      data: {
        sessionId: battlefield.sessionId,
        background: battlefield.background,
        lastUpdated: battlefield.lastUpdated
      }
    });
    
  } catch (error) {
    next(error);
  }
});

/**
 * @route   POST /api/v1/battlefield/sessions/:sessionId/pieces/:pieceId/move
 * @desc    移动棋子
 * @access  Public
 */
router.post('/sessions/:sessionId/pieces/:pieceId/move', async (req, res, next) => {
  try {
    const { sessionId, pieceId } = req.params;
    const { x, y } = req.body;
    
    if (x === undefined || y === undefined) {
      return res.status(400).json({
        success: false,
        error: '缺少位置数据'
      });
    }
    
    // 更新棋子位置
    const battlefield = await Battlefield.findOne({ sessionId });
    if (!battlefield) {
      return res.status(404).json({
        success: false,
        error: '找不到战场'
      });
    }
    
    // 找到要更新的棋子
    const pieceIndex = battlefield.pieces.findIndex(p => p.id === pieceId);
    let updatedPiece;
    
    if (pieceIndex === -1) {
      // 如果棋子不存在，创建新棋子
      updatedPiece = {
        id: pieceId,
        x: x,
        y: y,
        name: req.body.name || "",
        type: req.body.type || "monster",
        currentHp: req.body.currentHp || 0,
        maxHp: req.body.maxHp || 0
      };
      battlefield.pieces.push(updatedPiece);
    } else {
      // 更新现有棋子
      battlefield.pieces[pieceIndex].x = x;
      battlefield.pieces[pieceIndex].y = y;
      updatedPiece = battlefield.pieces[pieceIndex];
    }
    
    battlefield.lastUpdated = Date.now();
    await battlefield.save();
    
    // 通过Socket.io通知其他客户端
    req.app.get('io')?.to(sessionId).emit('piece-moved', {
      pieceId,
      x,
      y
    });
    
    res.json({
      success: true,
      data: {
        sessionId: battlefield.sessionId,
        piece: updatedPiece,
        lastUpdated: battlefield.lastUpdated
      }
    });
    
  } catch (error) {
    next(error);
  }
});

/**
 * @route   POST /api/v1/battlefield/sessions/:sessionId/settings
 * @desc    更新战场设置
 * @access  Public
 */
router.post('/sessions/:sessionId/settings', async (req, res, next) => {
  try {
    const { sessionId } = req.params;
    const { scale, gridVisible, pieceSize } = req.body;
    
    if (scale === undefined && gridVisible === undefined && pieceSize === undefined) {
      return res.status(400).json({
        success: false,
        error: '缺少设置数据'
      });
    }
    
    // 构建更新数据对象
    const updateData = {
      lastUpdated: Date.now()
    };
    
    if (scale !== undefined) {
      updateData['settings.scale'] = scale;
      req.app.get('io')?.to(sessionId).emit('scale-updated', { scale });
    }
    
    if (gridVisible !== undefined) {
      updateData['settings.gridVisible'] = gridVisible;
      req.app.get('io')?.to(sessionId).emit('grid-visibility-updated', { isVisible: gridVisible });
    }
    
    if (pieceSize !== undefined) {
      updateData['settings.pieceSize'] = pieceSize;
      req.app.get('io')?.to(sessionId).emit('piece-size-updated', { size: pieceSize });
    }
    
    // 更新战场设置
    const battlefield = await Battlefield.findOneAndUpdate(
      { sessionId },
      updateData,
      { new: true }
    );
    
    if (!battlefield) {
      return res.status(404).json({
        success: false,
        error: '找不到战场'
      });
    }
    
    res.json({
      success: true,
      data: {
        sessionId: battlefield.sessionId,
        settings: battlefield.settings,
        lastUpdated: battlefield.lastUpdated
      }
    });
    
  } catch (error) {
    next(error);
  }
});

module.exports = router;
