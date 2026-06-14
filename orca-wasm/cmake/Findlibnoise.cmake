# Findlibnoise.cmake — SoftFever's Orca-deps-libnoise built for WASM.
# Expects headers at <prefix>/include/libnoise/
# and static lib at <prefix>/lib/liblibnoise_static.a

# CMAKE_PREFIX_PATH is a CMake list (semicolon-separated). String-interpolating
# it directly ("${CMAKE_PREFIX_PATH}/include") produces one malformed path when
# there are multiple prefixes. Build the search lists explicitly instead.
set(_libnoise_inc_paths)
set(_libnoise_lib_paths)
foreach(_p IN LISTS CMAKE_PREFIX_PATH)
  list(APPEND _libnoise_inc_paths "${_p}/include")
  list(APPEND _libnoise_lib_paths "${_p}/lib")
endforeach()

find_path(_LIBNOISE_INCLUDE_DIR libnoise/noise.h
  PATHS ${_libnoise_inc_paths} NO_DEFAULT_PATH)
find_library(_LIBNOISE_LIB libnoise_static
  PATHS ${_libnoise_lib_paths} NO_DEFAULT_PATH)

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
