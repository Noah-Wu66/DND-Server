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
        pieces: new Map(),
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
        background: battlefield.background,
        pieces: Array.from(battlefield.pieces.values()),
        settings: battlefield.settings,
        lastUpdated: battlefield.lastUpdated
      }
    });
    
  } catch (error) {
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
    const { pieces, settings } = req.body;
    
    if (!pieces) {
      return res.status(400).json({
        success: false,
        error: '缺少棋子数据'
      });
    }
    
    // 构建更新数据对象
    const updateData = {
      pieces: new Map(pieces.map(piece => [piece.id, piece])),
      lastUpdated: Date.now()
    };
    
    // 如果提供了设置，也更新它
    if (settings) {
      updateData.settings = settings;
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
    req.app.get('io')?.to(sessionId).emit('battlefield-state-updated', {
      pieces: Array.from(battlefield.pieces.values()),
      settings: battlefield.settings
    });
    
    res.json({
      success: true,
      data: {
        sessionId: battlefield.sessionId,
        lastUpdated: battlefield.lastUpdated
      }
    });
    
  } catch (error) {
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
    
    const piece = battlefield.pieces.get(pieceId);
    if (!piece) {
      return res.status(404).json({
        success: false,
        error: '找不到棋子'
      });
    }
    
    piece.x = x;
    piece.y = y;
    battlefield.pieces.set(pieceId, piece);
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
        piece: piece,
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