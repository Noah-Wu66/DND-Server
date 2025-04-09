const mongoose = require('mongoose');

// 首先定义一个单独的 PieceSchema
const PieceSchema = new mongoose.Schema({
  id: String,
  name: String,
  type: String, 
  x: Number,
  y: Number,
  currentHp: Number,
  maxHp: Number
}, { _id: false }); // 禁止自动生成 _id

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
  // 使用单独定义的 PieceSchema
  pieces: {
    type: [PieceSchema],
    default: [],
    // 添加自定义转换器，确保数据始终是对象数组
    set: function(v) {
      if (!Array.isArray(v)) {
        console.error(`Attempting to set pieces with non-array: ${typeof v}`);
        return [];
      }
      return v.map(piece => {
        if (typeof piece === 'string') {
          try {
            return JSON.parse(piece);
          } catch (error) {
            console.error(`Error parsing piece string: ${error.message}`);
            return null;
          }
        }
        return piece;
      }).filter(Boolean); // 过滤掉无效值
    }
  },
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
