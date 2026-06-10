# FindJPEG.cmake — emscripten sysroot version.
# embuilder must have pre-built libjpeg before cmake runs.
set(_EM_SYSROOT "$ENV{EMSDK}/upstream/emscripten/cache/sysroot")

if(NOT TARGET JPEG::JPEG)
  add_library(JPEG::JPEG INTERFACE IMPORTED GLOBAL)
  target_include_directories(JPEG::JPEG INTERFACE "${_EM_SYSROOT}/include")
  target_link_libraries(JPEG::JPEG INTERFACE
    "${_EM_SYSROOT}/lib/wasm32-emscripten/libjpeg.a")
endif()
set(JPEG_FOUND TRUE)
set(JPEG_INCLUDE_DIRS "${_EM_SYSROOT}/include")
set(JPEG_LIBRARIES JPEG::JPEG)
