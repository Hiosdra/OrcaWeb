# Finddraco.cmake — stub for WASM builds.
if(NOT TARGET draco::draco)
  add_library(draco::draco INTERFACE IMPORTED GLOBAL)
endif()
set(draco_FOUND TRUE)
