# FindPNG.cmake — emscripten sysroot version.
# embuilder must have pre-built libpng before cmake runs.
set(_EM_SYSROOT "$ENV{EMSDK}/upstream/emscripten/cache/sysroot")

if(NOT TARGET PNG::PNG)
  add_library(PNG::PNG INTERFACE IMPORTED GLOBAL)
  target_include_directories(PNG::PNG INTERFACE "${_EM_SYSROOT}/include")
  target_link_libraries(PNG::PNG INTERFACE
    "${_EM_SYSROOT}/lib/wasm32-emscripten/libpng.a"
    ZLIB::ZLIB)
endif()
set(PNG_FOUND TRUE)
set(PNG_INCLUDE_DIRS "${_EM_SYSROOT}/include")
set(PNG_LIBRARIES PNG::PNG)
set(PNG_VERSION_STRING "1.6")
