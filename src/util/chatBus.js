// DigitalHub - Chat pub/sub bus (in-memory, buat SSE real-time).
// Catatan: ini jalan per-proses (satu server Node). Kalau nanti scale ke banyak
// server/instance, perlu upgrade ke Redis pub/sub — tapi untuk toko yang baru
// mulai, satu proses sudah lebih dari cukup.
'use strict';
const { EventEmitter } = require('events');

const bus = new EventEmitter();
bus.setMaxListeners(0); // banyak client bisa connect bersamaan

function publish(room, message) {
  bus.emit('msg:' + room, message);
}

function subscribe(room, handler) {
  const event = 'msg:' + room;
  bus.on(event, handler);
  return () => bus.off(event, handler);
}

module.exports = { publish, subscribe };
