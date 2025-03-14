const mongoose = require('mongoose');

const SessionSchema = new mongoose.Schema({
  sessionId: {
    type: String,
    required: true,
    unique: true,
    index: true
  },
  monsters: {
    type: mongoose.Schema.Types.Mixed,
    default: {}
  },
  // 新增字段用于存储怪物卡片顺序
  monsterOrder: {
    type: [String],
    default: []
  },
  lastUpdated: {
    type: Date,
    default: Date.now
  }
}, {
  timestamps: true
});

// 添加自动更新lastUpdated字段
SessionSchema.pre('save', function(next) {
  this.lastUpdated = Date.now();
  next();
});

// 同样为更新操作添加自动更新lastUpdated字段
SessionSchema.pre('findOneAndUpdate', function(next) {
  this.set({ lastUpdated: Date.now() });
  next();
});

module.exports = mongoose.model('Session', SessionSchema);
