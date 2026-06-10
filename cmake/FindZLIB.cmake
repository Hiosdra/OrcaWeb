# FindZLIB.cmake — emscripten sysroot version.
# embuilder must have pre-built zlib before cmake runs.
set(_EM_SYSROOT "$ENV{EMSDK}/upstream/emscripten/cache/sysroot")

if(NOT TARGET ZLIB::ZLIB)
  add_library(ZLIB::ZLIB INTERFACE IMPORTED GLOBAL)
  target_include_directories(ZLIB::ZLIB INTERFACE "${_EM_SYSROOT}/include")
  target_link_libraries(ZLIB::ZLIB INTERFACE "${_EM_SYSROOT}/lib/wasm32-emscripten/libz.a")
endif()
set(ZLIB_FOUND TRUE)
set(ZLIB_INCLUDE_DIRS "${_EM_SYSROOT}/include")
set(ZLIB_LIBRARIES ZLIB::ZLIB)
set(ZLIB_VERSION_STRING "1.2.13")
