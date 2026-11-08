# CMakeLists.txt — builds the AuraGrid realtime core as a shared library.
#
# Dependencies come from React Native's prefab packages plus Oboe, which RN's
# Gradle setup resolves from Maven. Nothing is vendored: no .so blobs in git.

cmake_minimum_required(VERSION 3.20)
project(auragrid_core CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

find_package(ReactAndroid REQUIRED CONFIG)
find_package(fbjni REQUIRED CONFIG)
find_package(oboe REQUIRED CONFIG)

add_library(auragrid_core SHARED
    OboeAudioEngine.cpp
    JsiAudioBindings.cpp)

target_include_directories(auragrid_core PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR})

target_compile_options(auragrid_core PRIVATE
    -Wall
    -Wextra
    -Wno-unused-parameter
    -ffast-math
    -fvisibility=hidden)

target_link_libraries(auragrid_core
    ReactAndroid::reactnative
    ReactAndroid::jsi
    fbjni::fbjni
    oboe::oboe
    android
    log)

# The core is hot code. Exceptions and RTTI stay enabled because the JSI host
# object boundary needs them; the audio callback itself throws nothing.
target_compile_options(auragrid_core PRIVATE -O3)
