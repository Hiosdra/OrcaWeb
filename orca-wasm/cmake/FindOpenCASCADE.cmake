# FindOpenCASCADE.cmake
#
# Locates an OCCT install for the current build context:
#   - WASM builds:   uses the Emscripten-built install at OCCT_WASM_DIR
#                    (set by deps/build_occt.sh / passed via -DOCCT_WASM_DIR=)
#   - Native builds: falls through to the system-installed opencascade
#                    CMake config (unchanged from upstream OrcaSlicer behaviour)
#
# Sets after a successful find:
#   OpenCASCADE_FOUND         BOOL
#   OpenCASCADE_INCLUDE_DIR   path to opencascade/ headers
#   OCCT_LIBS                 list of toolkit targets needed by libslic3r
#                             (matches the variable name used in OrcaSlicer's
#                             src/libslic3r/CMakeLists.txt)

# ── Resolve install prefix ─────────────────────────────────────────────────────
if(DEFINED OCCT_WASM_DIR)
  set(_occt_prefix "${OCCT_WASM_DIR}")
elseif(DEFINED ENV{OCCT_WASM_DIR})
  set(_occt_prefix "$ENV{OCCT_WASM_DIR}")
else()
  set(_occt_prefix "")
endif()

# ── Find via CMake config (works for both WASM install and native package) ────
if(_occt_prefix)
  find_package(opencascade CONFIG
    PATHS "${_occt_prefix}/lib/cmake/opencascade"
    NO_DEFAULT_PATH
    QUIET)

  if(opencascade_FOUND)
    set(OpenCASCADE_FOUND TRUE)
    # OCCT installs headers under $prefix/include/opencascade/
    set(OpenCASCADE_INCLUDE_DIR "${_occt_prefix}/include/opencascade")
    message(STATUS "Found OCCT ${opencascade_VERSION} (WASM) at ${_occt_prefix}")
  else()
    message(FATAL_ERROR
      "OCCT_WASM_DIR is set to '${_occt_prefix}' but no opencascade CMake config "
      "was found there.\n"
      "Run:  source deps/build_occt.sh")
  endif()
else()
  # Native: let OrcaSlicer's own find logic handle it
  find_package(opencascade CONFIG QUIET)
  if(opencascade_FOUND)
    set(OpenCASCADE_FOUND TRUE)
    if(NOT DEFINED OpenCASCADE_INCLUDE_DIR)
      # Modern OCCT config sets this via imported target properties; provide
      # a conventional variable as well for libslic3r's include_directories call.
      get_target_property(OpenCASCADE_INCLUDE_DIR TKernel INTERFACE_INCLUDE_DIRECTORIES)
    endif()
    message(STATUS "Found OCCT ${opencascade_VERSION} (system/native)")
  endif()
endif()

# ── Define OCCT_LIBS — the toolkit list libslic3r links against ───────────────
# This is the union of all toolkits required by Format/STEP.cpp (STEP + IGES
# import) and the BRep meshing layer.  Matches what occt-import-js bundles.
if(OpenCASCADE_FOUND)
  set(OCCT_LIBS
    TKernel
    TKMath
    TKG2d
    TKG3d
    TKGeomBase
    TKGeomAlgo
    TKBRep
    TKTopAlgo
    TKPrim
    TKBO
    TKBool
    TKShHealing
    TKFillet
    TKOffset
    TKMesh
    TKXSBase
    TKSTEP
    TKSTEP209
    TKSTEPAttr
    TKSTEPBase
    TKIGES
    TKLCAF
    TKXCAF
  )
endif()

include(FindPackageHandleStandardArgs)
find_package_handle_standard_args(OpenCASCADE
  REQUIRED_VARS OpenCASCADE_FOUND OpenCASCADE_INCLUDE_DIR OCCT_LIBS)
