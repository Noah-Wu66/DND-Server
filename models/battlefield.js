const mongoose = require('mongoose');

const battlefieldSchema = new mongoose.Schema({
  sessionId: {
    type: String,
    required: true,
    unique: true
  },
  background: {
    imageUrl: String,
    lastUpdated: Date
  },
  // 改为数组存储，不用Map
  pieces: [{
    id: String,
    name: String,
    type: String, 
    x: Number,
    y: Number,
    currentHp: Number,
    maxHp: Number
  }],
  settings: {
    scale: {
      type: Number,
      default: 1.0
    },
    gridVisible: {
      type: Boolean,
      default: true
    },
    pieceSize: {
      type: Number,
      default: 40
    }
  },
  lastUpdated: {
    type: Date,
    default: Date.now
  }
}, {
  timestamps: true
});

// 创建索引以提高查询性能
battlefieldSchema.index({ sessionId: 1 });
battlefieldSchema.index({ lastUpdated: -1 });

const Battlefield = mongoose.model('Battlefield', battlefieldSchema);

module.exports = Battlefield;
