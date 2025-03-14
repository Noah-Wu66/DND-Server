const express = require('express');
const router = express.Router();
const DiceSession = require('../models/diceSession');

/**
 * @route   GET /api/v1/dice/sessions/:sessionId
 * @desc    获取骰子会话数据
 * @access  Public
 */
router.get('/sessions/:sessionId', async (req, res, next) => {
  try {
    const { sessionId } = req.params;
    
    let session = await DiceSession.findOne({ sessionId });
    
    // 如果会话不存在，创建新会话
    if (!session) {
      session = new DiceSession({
        sessionId,
        diceState: {
          dice: {
            d4: 0,
            d6: 0,
            d8: 0,
            d10: 0,
            d12: 0,
            d20: 0
          },
          advantage: false,
          disadvantage: false
        },
        rollHistory: []
      });
      await session.save();
    }
    
    // 返回会话数据
    res.json({
      success: true,
      data: {
        sessionId: session.sessionId,
        diceState: session.diceState,
        rollHistory: session.rollHistory || [],
        lastUpdated: session.lastUpdated
      }
    });
    
  } catch (error) {
    next(error);
  }
});

/**
 * @route   POST /api/v1/dice/sessions/:sessionId
 * @desc    保存骰子会话数据
 * @access  Public
 */
router.post('/sessions/:sessionId', async (req, res, next) => {
  try {
    const { sessionId } = req.params;
    const { diceState, playerName } = req.body;
    
    if (!diceState) {
      return res.status(400).json({
        success: false,
        error: '缺少骰子数据'
      });
    }
    
    // 更新或创建会话
    const session = await DiceSession.findOneAndUpdate(
      { sessionId },
      {
        diceState,
        lastUpdated: Date.now()
      },
      {
        new: true,
        upsert: true
      }
    );
    
    // 通过Socket.io通知其他客户端(在server.js中处理)
    req.app.get('io')?.to(sessionId).emit('dice-state-updated', session.diceState);
    
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
 * @route   POST /api/v1/dice/sessions/:sessionId/roll
 * @desc    记录骰子投掷
 * @access  Public
 */
router.post('/sessions/:sessionId/roll', async (req, res, next) => {
  try {
    const { sessionId } = req.params;
    const { rollData } = req.body;
    
    if (!rollData) {
      return res.status(400).json({
        success: false,
        error: '缺少骰子投掷数据'
      });
    }
    
    // 查找会话
    let session = await DiceSession.findOne({ sessionId });
    if (!session) {
      return res.status(404).json({
        success: false,
        error: '找不到会话'
      });
    }
    
    // 如果历史记录不存在，创建一个空数组
    if (!session.rollHistory) {
      session.rollHistory = [];
    }
    
    // 限制历史记录大小
    if (session.rollHistory.length >= 20) {
      session.rollHistory.shift(); // 移除最旧的记录
    }
    
    // 添加新的骰子投掷记录
    session.rollHistory.push(rollData);
    
    // 保存更新
    session.lastUpdated = Date.now();
    await session.save();
    
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
 * @route   DELETE /api/v1/dice/sessions/:sessionId/history
 * @desc    清空骰子历史记录
 * @access  Public
 */
router.delete('/sessions/:sessionId/history', async (req, res, next) => {
  try {
    const { sessionId } = req.params;
    
    // 更新会话，清空历史记录
    const session = await DiceSession.findOneAndUpdate(
      { sessionId },
      {
        rollHistory: [],
        lastUpdated: Date.now()
      },
      { new: true }
    );
    
    if (!session) {
      return res.status(404).json({
        success: false,
        error: '找不到会话'
      });
    }
    
    res.json({
      success: true,
      message: '历史记录已清空',
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
 * @route   POST /api/v1/dice/sessions/:sessionId/advantage
 * @desc    设置优势/劣势状态
 * @access  Public
 */
router.post('/sessions/:sessionId/advantage', async (req, res, next) => {
  try {
    const { sessionId } = req.params;
    const { hasAdvantage, hasDisadvantage } = req.body;
    
    if (hasAdvantage === undefined && hasDisadvantage === undefined) {
      return res.status(400).json({
        success: false,
        error: '缺少优势/劣势状态数据'
      });
    }
    
    // 构建更新数据对象
    const updateData = {
      lastUpdated: Date.now()
    };
    
    if (hasAdvantage !== undefined) {
      updateData['diceState.advantage'] = hasAdvantage;
    }
    
    if (hasDisadvantage !== undefined) {
      updateData['diceState.disadvantage'] = hasDisadvantage;
    }
    
    // 更新会话的优势/劣势状态
    const session = await DiceSession.findOneAndUpdate(
      { sessionId },
      updateData,
      { new: true }
    );
    
    if (!session) {
      return res.status(404).json({
        success: false,
        error: '找不到会话'
      });
    }
    
    // 通过Socket.io通知其他客户端
    req.app.get('io')?.to(sessionId).emit('advantage-updated', {
      hasAdvantage: session.diceState.advantage,
      hasDisadvantage: session.diceState.disadvantage
    });
    
    res.json({
      success: true,
      data: {
        sessionId: session.sessionId,
        diceState: session.diceState,
        lastUpdated: session.lastUpdated
      }
    });
    
  } catch (error) {
    next(error);
  }
});

/**
 * @route   GET /api/v1/dice/sessions/:sessionId/statistics
 * @desc    获取骰子统计信息
 * @access  Public
 */
router.get('/sessions/:sessionId/statistics', async (req, res, next) => {
  try {
    const { sessionId } = req.params;
    
    const session = await DiceSession.findOne({ sessionId });
    if (!session) {
      return res.status(404).json({
        success: false,
        error: '找不到会话'
      });
    }
    
    // 计算统计信息
    const statistics = {
      totalRolls: session.rollHistory.length,
      diceDistribution: {
        d4: 0,
        d6: 0,
        d8: 0,
        d10: 0,
        d12: 0,
        d20: 0
      },
      averageRolls: {
        d4: 0,
        d6: 0,
        d8: 0,
        d10: 0,
        d12: 0,
        d20: 0
      },
      criticalSuccesses: 0,
      criticalFailures: 0
    };
    
    // 分析历史记录
    session.rollHistory.forEach(roll => {
      // 统计骰子使用情况
      Object.keys(roll.dice).forEach(die => {
        if (statistics.diceDistribution[die] !== undefined) {
          statistics.diceDistribution[die]++;
        }
      });
      
      // 计算平均点数
      Object.keys(roll.results).forEach(die => {
        if (statistics.averageRolls[die] !== undefined) {
          const currentTotal = statistics.averageRolls[die] * statistics.diceDistribution[die];
          statistics.averageRolls[die] = (currentTotal + roll.results[die]) / (statistics.diceDistribution[die] + 1);
        }
      });
      
      // 统计关键成功和失败
      if (roll.results.d20) {
        if (roll.results.d20 === 20) {
          statistics.criticalSuccesses++;
        } else if (roll.results.d20 === 1) {
          statistics.criticalFailures++;
        }
      }
    });
    
    res.json({
      success: true,
      data: {
        sessionId: session.sessionId,
        statistics,
        lastUpdated: session.lastUpdated
      }
    });
    
  } catch (error) {
    next(error);
  }
});

module.exports = router;
