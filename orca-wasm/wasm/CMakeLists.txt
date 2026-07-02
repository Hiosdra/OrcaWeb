# Final Emscripten WASM module target.
# Links libslic3r + our bridge and emits slicer.js / slicer.wasm / slicer.data.

# Emscripten requires an "executable" target even though the output is a .js module.
add_executable(slicer "${CMAKE_CURRENT_SOURCE_DIR}/empty_main.cpp")

target_link_libraries(slicer PRIVATE orca_web_bridge)

# ── Emscripten link flags ────────────────────────────────────────────────────
target_link_options(slicer PRIVATE
  -O3
  -sALLOW_MEMORY_GROWTH=1
  -sMALLOC=emmalloc
  -sSTACK_SIZE=16777216
  -sINITIAL_MEMORY=268435456
  -sMAXIMUM_MEMORY=4294967296
  -sABORTING_MALLOC=0
  -sENVIRONMENT=web,worker,node
  -sMODULARIZE=1
  -sEXPORT_NAME=OrcaModule
  -sDISABLE_EXCEPTION_CATCHING=0
  # EMULATE_FUNCTION_POINTER_CASTS + a raised max-func-params was tried here
  # to fix a real crash (slicing the official Voron Design Cube v7 STL traps
  # with "memory access out of bounds" — a mismatched-signature indirect call
  # in the mesh-repair path, reproducible with scripts/repro-real-stl.mjs).
  # It backfired: at -O2 with max-func-params raised to 64, the emulation
  # trampolines themselves became broken at runtime — even a trivial
  # 12-triangle cube started crashing the same way. That's strictly worse
  # than the original bug (which only hit specific real-world meshes), so
  # it was reverted. The Voron Cube crash is still open; needs a source-level
  # fix (the actual offending call site) rather than a Binaryen emulation flag.
  -fexceptions
  # No --preload-file: the headless flat-config slicer never reads orca/resources
  # at runtime (verified in-browser — a full slice opens only /tmp/*.stl/.gcode,
  # zero /resources access, and slicing is byte-identical with /resources removed).
  # Dropping the ~200 MB preload removes slicer.data entirely.  FORCE_FILESYSTEM
  # keeps MEMFS available for the bridge's /tmp STL-in / G-code-out files.
  -sFORCE_FILESYSTEM=1
  # Exported C functions consumed by the JS runtime
  "-sEXPORTED_FUNCTIONS=[\
'_orc_init',\
'_orc_slice',\
'_orc_obj_to_stl',\
'_orc_cad_to_stl',\
'_orc_free',\
'_orc_decode_exception',\
'_malloc',\
'_free'\
]"
  "-sEXPORTED_RUNTIME_METHODS=[\
'ccall',\
'cwrap',\
'getValue',\
'setValue',\
'UTF8ToString',\
'stringToUTF8',\
'lengthBytesUTF8',\
'HEAP8',\
'HEAPU8',\
'HEAP32',\
'HEAPU32'\
]"
)

# Rename Emscripten output to slicer.js/.wasm/.data
set_target_properties(slicer PROPERTIES
  OUTPUT_NAME slicer
  SUFFIX ".js"
)

# Copy artifacts to the web app's public/wasm/ after build
add_custom_command(TARGET slicer POST_BUILD
  COMMAND ${CMAKE_COMMAND} -E make_directory
    "${CMAKE_CURRENT_SOURCE_DIR}/../../public/wasm"
  COMMAND ${CMAKE_COMMAND} -E copy_if_different
    "${CMAKE_CURRENT_BINARY_DIR}/slicer.js"
    "${CMAKE_CURRENT_SOURCE_DIR}/../../public/wasm/slicer.js"
  COMMAND ${CMAKE_COMMAND} -E copy_if_different
    "${CMAKE_CURRENT_BINARY_DIR}/slicer.wasm"
    "${CMAKE_CURRENT_SOURCE_DIR}/../../public/wasm/slicer.wasm"
  # No slicer.data: the engine is built without --preload-file.
  COMMENT "Copying WASM artifacts to public/wasm/"
)
