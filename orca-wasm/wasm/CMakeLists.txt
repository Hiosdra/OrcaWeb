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
  -sEMULATE_FUNCTION_POINTER_CASTS=1
  -fexceptions
  # Preload OrcaSlicer resource bundle (profiles, materials, etc.)
  "--preload-file=${CMAKE_CURRENT_SOURCE_DIR}/../orca/resources@/resources"
  # Exported C functions consumed by the JS runtime
  "-sEXPORTED_FUNCTIONS=[\
'_orc_init',\
'_orc_slice',\
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
  COMMAND ${CMAKE_COMMAND} -E copy_if_different
    "${CMAKE_CURRENT_BINARY_DIR}/slicer.data"
    "${CMAKE_CURRENT_SOURCE_DIR}/../../public/wasm/slicer.data"
  COMMENT "Copying WASM artifacts to public/wasm/"
)
