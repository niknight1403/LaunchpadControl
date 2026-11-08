// JsiAudioBindings.cpp — exposes the realtime core to JS without the bridge.
//
// Every method here is a synchronous JSI host function: no JSON, no promise,
// no allocation of a native->JS argument map. That is the whole point: a bridged
// call costs 0.5–2 ms and allocates, which is a third of the audio quantum.
//
// Lifetime: one engine per process, owned by a static. JS calls stop() to tear
// the stream down; the object stays alive so a restart is cheap.

#include <jni.h>

#include <jsi/jsi.h>

#include <memory>
#include <string>
#include <vector>

#include "OboeAudioEngine.hpp"

using facebook::jsi::Array;
using facebook::jsi::Function;
using facebook::jsi::HostFunctionType;
using facebook::jsi::HostObject;
using facebook::jsi::Object;
using facebook::jsi::Runtime;
using facebook::jsi::Value;

namespace {

std::unique_ptr<auragrid::OboeAudioEngine>& engine() {
  static std::unique_ptr<auragrid::OboeAudioEngine> instance;
  if (!instance) instance = std::make_unique<auragrid::OboeAudioEngine>();
  return instance;
}

int32_t int1(const Value* args, std::size_t index) {
  return args[index].isNumber() ? static_cast<int32_t>(args[index].getNumber()) : 0;
}

double num(const Value* args, std::size_t index) {
  return args[index].isNumber() ? args[index].getNumber() : 0.0;
}

class AuraCoreHostObject : public HostObject {
 public:
  Value get(Runtime& rt, const facebook::jsi::PropNameID& name) override {
    const std::string key = name.utf8(rt);

    if (key == "start") {
      return Function::createFromHostFunction(
          rt, name, 3,
          [](Runtime&, const Value&, const Value* args, std::size_t) -> Value {
            const bool ok = engine()->start(int1(args, 0), int1(args, 1),
                                            static_cast<float>(num(args, 2)));
            return Value(ok);
          });
    }
    if (key == "stop") {
      return Function::createFromHostFunction(
          rt, name, 0, [](Runtime&, const Value&, const Value*, std::size_t) -> Value {
            engine()->stop();
            return Value::undefined();
          });
    }
    if (key == "loadClip") {
      return Function::createFromHostFunction(
          rt, name, 3,
          [](Runtime& rt2, const Value&, const Value* args, std::size_t) -> Value {
            if (!args[1].isString()) return Value(-1);
            const std::string path = args[1].getString(rt2).utf8(rt2);
            const int32_t slot = engine()->loadClip(int1(args, 0), path, num(args, 2));
            return Value(static_cast<double>(slot));
          });
    }
    if (key == "unloadClip") {
      return Function::createFromHostFunction(
          rt, name, 2, [](Runtime&, const Value&, const Value* args, std::size_t) -> Value {
            engine()->unloadClip(int1(args, 0), int1(args, 1));
            return Value::undefined();
          });
    }
    if (key == "triggerPad") {
      return Function::createFromHostFunction(
          rt, name, 3, [](Runtime&, const Value&, const Value* args, std::size_t) -> Value {
            engine()->triggerPad(int1(args, 0), int1(args, 1), static_cast<float>(num(args, 2)));
            return Value::undefined();
          });
    }
    if (key == "stopDeck") {
      return Function::createFromHostFunction(
          rt, name, 1, [](Runtime&, const Value&, const Value* args, std::size_t) -> Value {
            engine()->stopDeck(int1(args, 0));
            return Value::undefined();
          });
    }
    if (key == "setDeckGain") {
      return Function::createFromHostFunction(
          rt, name, 2, [](Runtime&, const Value&, const Value* args, std::size_t) -> Value {
            engine()->setDeckGain(int1(args, 0), static_cast<float>(num(args, 1)));
            return Value::undefined();
          });
    }
    if (key == "setStemGain") {
      return Function::createFromHostFunction(
          rt, name, 3, [](Runtime&, const Value&, const Value* args, std::size_t) -> Value {
            engine()->setStemGain(int1(args, 0), int1(args, 1), static_cast<float>(num(args, 2)));
            return Value::undefined();
          });
    }
    if (key == "setFx") {
      return Function::createFromHostFunction(
          rt, name, 3, [](Runtime&, const Value&, const Value* args, std::size_t) -> Value {
            engine()->setFx(int1(args, 0), int1(args, 1), static_cast<float>(num(args, 2)));
            return Value::undefined();
          });
    }
    if (key == "setMasterGain") {
      return Function::createFromHostFunction(
          rt, name, 1, [](Runtime&, const Value&, const Value* args, std::size_t) -> Value {
            engine()->setMasterGain(static_cast<float>(num(args, 0)));
            return Value::undefined();
          });
    }
    if (key == "setTransport") {
      return Function::createFromHostFunction(
          rt, name, 2, [](Runtime&, const Value&, const Value* args, std::size_t) -> Value {
            engine()->setTransport(num(args, 0), num(args, 1));
            return Value::undefined();
          });
    }
    if (key == "setLoop") {
      return Function::createFromHostFunction(
          rt, name, 3, [](Runtime&, const Value&, const Value* args, std::size_t) -> Value {
            const auto start = static_cast<int64_t>(num(args, 1));
            const auto end = static_cast<int64_t>(num(args, 2));
            engine()->setLoop(int1(args, 0), start, end);
            return Value::undefined();
          });
    }
    if (key == "clearLoop") {
      return Function::createFromHostFunction(
          rt, name, 1, [](Runtime&, const Value&, const Value* args, std::size_t) -> Value {
            engine()->clearLoop(int1(args, 0));
            return Value::undefined();
          });
    }
    if (key == "seek") {
      return Function::createFromHostFunction(
          rt, name, 2, [](Runtime&, const Value&, const Value* args, std::size_t) -> Value {
            engine()->seek(int1(args, 0), static_cast<int64_t>(num(args, 1)));
            return Value::undefined();
          });
    }
    if (key == "setDeckRate") {
      return Function::createFromHostFunction(
          rt, name, 2, [](Runtime&, const Value&, const Value* args, std::size_t) -> Value {
            engine()->setDeckRate(int1(args, 0), static_cast<float>(num(args, 1)));
            return Value::undefined();
          });
    }
    if (key == "setCrossfader") {
      return Function::createFromHostFunction(
          rt, name, 1, [](Runtime&, const Value&, const Value* args, std::size_t) -> Value {
            engine()->setCrossfader(static_cast<float>(num(args, 0)));
            return Value::undefined();
          });
    }
    if (key == "pollEvents") {
      return Function::createFromHostFunction(
          rt, name, 0,
          [](Runtime& rt2, const Value&, const Value*, std::size_t) -> Value {
            const std::vector<auragrid::EngineEvent> drained = engine()->drainEvents(64);
            Array result(rt2, drained.size());
            for (std::size_t i = 0; i < drained.size(); ++i) {
              Array tuple(rt2, 3);
              tuple.setValueAtIndex(rt2, 0, Value(static_cast<int>(drained[i].type)));
              tuple.setValueAtIndex(rt2, 1, Value(drained[i].deck));
              tuple.setValueAtIndex(rt2, 2, Value(drained[i].pad));
              result.setValueAtIndex(rt2, i, tuple);
            }
            return result;
          });
    }
    if (key == "latencyMs") {
      return Function::createFromHostFunction(
          rt, name, 0, [](Runtime&, const Value&, const Value*, std::size_t) -> Value {
            return Value(engine()->latencyMs());
          });
    }
    if (key == "cpuLoad") {
      return Function::createFromHostFunction(
          rt, name, 0, [](Runtime&, const Value&, const Value*, std::size_t) -> Value {
            return Value(engine()->cpuLoad());
          });
    }
    if (key == "xruns") {
      return Function::createFromHostFunction(
          rt, name, 0, [](Runtime&, const Value&, const Value*, std::size_t) -> Value {
            return Value(engine()->xruns());
          });
    }
    if (key == "activeVoices") {
      return Function::createFromHostFunction(
          rt, name, 0, [](Runtime&, const Value&, const Value*, std::size_t) -> Value {
            return Value(engine()->activeVoices());
          });
    }
    if (key == "masterPeak") {
      return Function::createFromHostFunction(
          rt, name, 0, [](Runtime&, const Value&, const Value*, std::size_t) -> Value {
            return Value(engine()->masterPeak());
          });
    }
    if (key == "transportBeats") {
      return Function::createFromHostFunction(
          rt, name, 0, [](Runtime&, const Value&, const Value*, std::size_t) -> Value {
            return Value(engine()->transportBeats());
          });
    }

    return Value::undefined();
  }

  std::vector<facebook::jsi::PropNameID> getPropertyNames(Runtime& rt) override {
    std::vector<facebook::jsi::PropNameID> names;
    for (const char* key :
         {"start", "stop", "loadClip", "unloadClip", "triggerPad", "stopDeck", "setDeckGain",
          "setStemGain", "setFx", "setMasterGain", "setTransport", "setCrossfader", "setLoop",
          "clearLoop", "setDeckRate", "seek", "pollEvents",
          "latencyMs", "cpuLoad", "xruns", "activeVoices", "masterPeak", "transportBeats"}) {
      names.push_back(facebook::jsi::PropNameID::forAscii(rt, key));
    }
    return names;
  }
};

void install(Runtime& runtime) {
  Object core = Object::createFromHostObject(runtime, std::make_shared<AuraCoreHostObject>());
  runtime.global().setProperty(runtime, "__AURAGRID_CORE__", std::move(core));
}

}  // namespace

extern "C" JNIEXPORT jboolean JNICALL
Java_com_auragrid_launchpad_AuraCoreModule_installNative(JNIEnv* env, jobject /*thiz*/, jlong runtimePtr) {
  if (runtimePtr == 0) return JNI_FALSE;
  auto* runtime = reinterpret_cast<Runtime*>(runtimePtr);
  try {
    install(*runtime);
    return JNI_TRUE;
  } catch (...) {
    return JNI_FALSE;
  }
}
