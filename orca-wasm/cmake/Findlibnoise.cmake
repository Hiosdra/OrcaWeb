# Findlibnoise.cmake — SoftFever's Orca-deps-libnoise built for WASM.
# Expects headers at ${CMAKE_PREFIX_PATH}/include/libnoise/
# and static lib at ${CMAKE_PREFIX_PATH}/lib/liblibnoise_static.a
find_path(_LIBNOISE_INCLUDE_DIR libnoise/noise.h
  PATHS "${CMAKE_PREFIX_PATH}/include" NO_DEFAULT_PATH)
find_library(_LIBNOISE_LIB libnoise_static
  PATHS "${CMAKE_PREFIX_PATH}/lib" NO_DEFAULT_PATH)

if(_LIBNOISE_INCLUDE_DIR AND _LIBNOISE_LIB)
  if(NOT TARGET noise::noise)
    add_library(noise::noise STATIC IMPORTED GLOBAL)
    set_target_properties(noise::noise PROPERTIES
      IMPORTED_LOCATION "${_LIBNOISE_LIB}"
      INTERFACE_INCLUDE_DIRECTORIES "${_LIBNOISE_INCLUDE_DIR}")
  endif()
  set(libnoise_FOUND TRUE)
  set(LIBNOISE_FOUND TRUE)
else()
  if(libnoise_FIND_REQUIRED)
    message(FATAL_ERROR
      "libnoise not found in ${CMAKE_PREFIX_PATH} — "
      "run the 'Build WASM deps — libnoise' CI step first.")
  endif()
  set(libnoise_FOUND FALSE)
endif()
