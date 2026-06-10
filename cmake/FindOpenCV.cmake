# FindOpenCV.cmake — stub for WASM builds.
# OrcaSlicer guards OpenCV usage with #ifdef SLIC3R_HAVE_OPENCV; with the
# SLIC3R_WASM define applied by the patcher all those paths are disabled.
if(NOT TARGET opencv_world)
  add_library(opencv_world INTERFACE IMPORTED GLOBAL)
endif()
set(OpenCV_FOUND TRUE)
set(OpenCV_LIBS  opencv_world)
