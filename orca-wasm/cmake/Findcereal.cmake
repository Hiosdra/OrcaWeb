# Findcereal.cmake — points to cereal installed in deps-install.
# cereal is header-only; it installs include/cereal/ and cmake config files.
# We try CMAKE_PREFIX_PATH first (which includes deps-install), then fall back.
find_path(_CEREAL_INCLUDE_DIR cereal/cereal.hpp
  PATHS "${CMAKE_PREFIX_PATH}/include" NO_DEFAULT_PATH)

if(_CEREAL_INCLUDE_DIR)
  if(NOT TARGET cereal::cereal)
    add_library(cereal::cereal INTERFACE IMPORTED GLOBAL)
    target_include_directories(cereal::cereal INTERFACE "${_CEREAL_INCLUDE_DIR}")
  endif()
  set(cereal_FOUND TRUE)
  set(CEREAL_FOUND TRUE)
  set(CEREAL_INCLUDE_DIR "${_CEREAL_INCLUDE_DIR}")
else()
  if(cereal_FIND_REQUIRED)
    message(FATAL_ERROR "cereal not found in ${CMAKE_PREFIX_PATH}/include — "
      "run the 'Build WASM deps' CI step first.")
  endif()
  set(cereal_FOUND FALSE)
endif()
