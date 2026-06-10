# Included via CMAKE_PROJECT_INCLUDE_BEFORE, which runs just before the
# top-level project() call — i.e. AFTER the emscripten toolchain file has run.
# Setting these as normal variables here shadows the toolchain's ONLY settings,
# letting find_path/find_library search both sysroot and our deps-install/.
set(CMAKE_FIND_ROOT_PATH_MODE_INCLUDE BOTH)
set(CMAKE_FIND_ROOT_PATH_MODE_LIBRARY BOTH)
set(CMAKE_FIND_ROOT_PATH_MODE_PACKAGE BOTH)
