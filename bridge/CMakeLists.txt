add_library(orca_web_bridge STATIC slicer.cpp)

target_include_directories(orca_web_bridge
  BEFORE PUBLIC
    # TBB shims must come before any real TBB headers
    "${CMAKE_CURRENT_SOURCE_DIR}/../wasm/shims"
)

target_include_directories(orca_web_bridge
  PUBLIC
    "${ORCA_SRC}"
    "${ORCA_DEPS}/eigen"
    "${ORCA_DEPS}/nlohmann_json/include"
    "${BOOST_INC}"
)

target_compile_definitions(orca_web_bridge PUBLIC
  SLIC3R_WASM
  __EMSCRIPTEN__
)

target_link_libraries(orca_web_bridge PUBLIC libslic3r)
