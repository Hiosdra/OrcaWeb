# Included via CMAKE_PROJECT_INCLUDE_BEFORE, which runs just before the
# top-level project() call — i.e. AFTER the emscripten toolchain file has run.
# Setting these as normal variables here shadows the toolchain's ONLY settings,
# letting find_path/find_library search both sysroot and our deps-install/.
set(CMAKE_FIND_ROOT_PATH_MODE_INCLUDE BOTH)
set(CMAKE_FIND_ROOT_PATH_MODE_LIBRARY BOTH)
set(CMAKE_FIND_ROOT_PATH_MODE_PACKAGE BOTH)

# Emscripten uses single-threaded mode; pthreads are in libc so FindThreads
# prints "Found Threads: TRUE" but may not create the Threads::Threads imported
# target in all CMake versions.  Provide a no-op stub so any cmake target that
# links Threads::Threads (e.g. the OrcaSlicer GUI exe we don't actually build)
# passes the target-exists check at cmake generation time.
if(NOT TARGET Threads::Threads)
    add_library(Threads::Threads INTERFACE IMPORTED GLOBAL)
endif()

# Directory-scope compile definitions for the entire WASM build tree.
# Using add_compile_definitions here (rather than CMAKE_CXX_FLAGS or
# target_compile_definitions) is the most reliable way to ensure these
# symbols are visible to every translation unit, including PCH and any
# file that includes OCCT-gated headers via the Model.hpp include chain.
add_compile_definitions(
    SLIC3R_WASM=1
    SLIC3R_NO_OCCT=1
    SLIC3R_NO_OPENVDB=1
    SLIC3R_NO_OPENCV=1
)
