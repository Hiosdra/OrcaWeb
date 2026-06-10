# FindTBB.cmake — shim for WASM builds.
# Creates interface targets TBB::tbb and TBB::tbbmalloc that satisfy
# find_package(TBB REQUIRED) without linking any real threading library.

if(NOT DEFINED TBB_SHIM_DIR)
  set(TBB_SHIM_DIR "${CMAKE_CURRENT_LIST_DIR}/../wasm/shims")
endif()

if(NOT TARGET TBB::tbb)
  add_library(TBB::tbb INTERFACE IMPORTED GLOBAL)
  set_target_properties(TBB::tbb PROPERTIES
    INTERFACE_INCLUDE_DIRECTORIES "${TBB_SHIM_DIR}")
endif()

if(NOT TARGET TBB::tbbmalloc)
  add_library(TBB::tbbmalloc INTERFACE IMPORTED GLOBAL)
endif()

if(NOT TARGET TBB::tbbmalloc_proxy)
  add_library(TBB::tbbmalloc_proxy INTERFACE IMPORTED GLOBAL)
endif()

set(TBB_FOUND   TRUE)
set(TBB_VERSION "2021.0")
set(TBB_INCLUDE_DIRS "${TBB_SHIM_DIR}")
set(TBB_LIBRARIES    TBB::tbb)
