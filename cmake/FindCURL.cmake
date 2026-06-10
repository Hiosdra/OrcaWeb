# FindCURL.cmake — WASM stub.
# Network operations are not available in WASM; provide empty targets so
# OrcaSlicer's root CMakeLists.txt can create its libcurl interface library.
if(NOT TARGET CURL::libcurl)
  add_library(CURL::libcurl INTERFACE IMPORTED GLOBAL)
endif()
set(CURL_FOUND TRUE)
set(CURL_LIBRARIES CURL::libcurl)
set(CURL_INCLUDE_DIRS "")
