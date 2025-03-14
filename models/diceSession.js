const mongoose = require('mongoose');

const DiceSessionSchema = new mongoose.Schema({
  sessionId: {
    type: String,
    required: true,
    unique: true,
    index: true
  },
  diceState: {
    type: mongoose.Schema.Types.Mixed,
    default: {}
  },
  rollHistory: {
    type: [mongoose.Schema.Types.Mixed],
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
DiceSessionSchema.pre('save', function(next) {
  this.lastUpdated = Date.now();
  next();
});

// 为更新操作添加自动更新lastUpdated字段
DiceSessionSchema.pre('findOneAndUpdate', function(next) {
  this.set({ lastUpdated: Date.now() });
  next();
});

module.exports = mongoose.model('DiceSession', DiceSessionSchema);
