const express = require('express');
const router = express.Router();
const Session = require('../models/session');

/**
 * @route   GET /api/v1/battles/sessions/:sessionId
 * @desc    获取战斗会话数据
 * @access  Public
 */
router.get('/sessions/:sessionId', async (req, res, next) => {
  try {
    const { sessionId } = req.params;
    
    let session = await Session.findOne({ sessionId });
    
    // 如果会话不存在，创建新会话
    if (!session) {
      session = new Session({
        sessionId,
        monsters: {},
        monsterOrder: [] // 初始化为空数组
      });
      await session.save();
    }
    
    // 返回会话数据，包含怪物顺序
    res.json({
      success: true,
      data: {
        sessionId: session.sessionId,
        monsters: session.monsters,
        monsterOrder: session.monsterOrder || [], // 确保有返回顺序数据
        lastUpdated: session.lastUpdated
      }
    });
    
  } catch (error) {
    next(error);
  }
});

/**
 * @route   POST /api/v1/battles/sessions/:sessionId
 * @desc    保存战斗会话数据
 * @access  Public
 */
router.post('/sessions/:sessionId', async (req, res, next) => {
  try {
    const { sessionId } = req.params;
    const { monsters, monsterOrder } = req.body;
    
    if (!monsters) {
      return res.status(400).json({
        success: false,
        error: '缺少怪物数据'
      });
    }
    
    // 构建更新数据对象
    const updateData = {
      monsters,
      lastUpdated: Date.now()
    };
    
    // 如果提供了怪物顺序，也更新它
    if (monsterOrder && Array.isArray(monsterOrder)) {
      updateData.monsterOrder = monsterOrder;
    }
    
    // 更新或创建会话
    const session = await Session.findOneAndUpdate(
      { sessionId },
      updateData,
      {
        new: true,
        upsert: true
      }
    );
    
    // 通过Socket.io通知其他客户端(在server.js中处理)
    req.app.get('io')?.to(sessionId).emit('session-updated', {
      monsters: session.monsters,
      monsterOrder: session.monsterOrder
    });
    
    res.json({
      success: true,
      data: {
        sessionId: session.sessionId,
        lastUpdated: session.lastUpdated
      }
    });
    
  } catch (error) {
    next(error);
  }
});

/**
 * @route   DELETE /api/v1/battles/sessions/:sessionId
 * @desc    删除战斗会话
 * @access  Public
 */
router.delete('/sessions/:sessionId', async (req, res, next) => {
  try {
    const { sessionId } = req.params;
    
    const result = await Session.deleteOne({ sessionId });
    
    if (result.deletedCount === 0) {
      return res.status(404).json({
        success: false,
        error: '会话不存在'
      });
    }
    
    res.json({
      success: true,
      message: '会话已删除'
    });
    
  } catch (error) {
    next(error);
  }
});

/**
 * @route   GET /api/v1/battles/sessions
 * @desc    获取所有会话的列表(仅用于管理目的)
 * @access  Public (可以增加授权保护)
 */
router.get('/sessions', async (req, res, next) => {
  try {
    const sessions = await Session.find({}, 'sessionId lastUpdated createdAt')
      .sort({ lastUpdated: -1 })
      .limit(100);
    
    res.json({
      success: true,
      data: sessions
    });
    
  } catch (error) {
    next(error);
  }
});

module.exports = router;
