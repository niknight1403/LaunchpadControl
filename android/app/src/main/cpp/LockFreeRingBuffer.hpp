// LockFreeRingBuffer.hpp — single-producer / single-consumer ring.
//
// Used on both realtime boundaries of the engine:
//   JS thread  → audio callback : AudioCommand
//   audio callback → JS thread  : EngineEvent
//
// Hard constraints: no allocation after construction, no locks, no syscalls.
// Capacity is rounded up to a power of two so the index wrap is a mask.

#pragma once

#include <atomic>
#include <cstddef>
#include <cstdint>
#include <type_traits>
#include <vector>

namespace auragrid {

template <typename T>
class LockFreeRingBuffer {
  static_assert(std::is_trivially_copyable<T>::value,
                "Ring buffer items must be trivially copyable: no strings, no vectors.");

 public:
  explicit LockFreeRingBuffer(std::size_t capacity) {
    std::size_t size = 1;
    while (size < capacity) size <<= 1;
    capacity_ = size;
    mask_ = size - 1;
    buffer_.resize(size);
  }

  LockFreeRingBuffer(const LockFreeRingBuffer&) = delete;
  LockFreeRingBuffer& operator=(const LockFreeRingBuffer&) = delete;

  // Producer side. Returns false when full — the caller decides whether to
  // count a drop. Never blocks: a blocked producer is a dropped frame on stage.
  bool push(const T& item) noexcept {
    const std::size_t write = writeIndex_.load(std::memory_order_relaxed);
    const std::size_t read = readIndex_.load(std::memory_order_acquire);
    if (write - read >= capacity_) return false;
    buffer_[write & mask_] = item;
    writeIndex_.store(write + 1, std::memory_order_release);
    return true;
  }

  // Consumer side.
  bool pop(T& out) noexcept {
    const std::size_t read = readIndex_.load(std::memory_order_relaxed);
    const std::size_t write = writeIndex_.load(std::memory_order_acquire);
    if (read == write) return false;
    out = buffer_[read & mask_];
    readIndex_.store(read + 1, std::memory_order_release);
    return true;
  }

  std::size_t size() const noexcept {
    const std::size_t write = writeIndex_.load(std::memory_order_acquire);
    const std::size_t read = readIndex_.load(std::memory_order_acquire);
    return write - read;
  }

  bool empty() const noexcept { return size() == 0; }
  std::size_t capacity() const noexcept { return capacity_; }

 private:
  std::vector<T> buffer_;
  std::size_t capacity_ = 0;
  std::size_t mask_ = 0;
  alignas(64) std::atomic<std::size_t> writeIndex_{0};
  alignas(64) std::atomic<std::size_t> readIndex_{0};
};

}  // namespace auragrid
