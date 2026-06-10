#pragma once
// Shim version header — report TBB 2021 so OrcaSlicer uses the modern
// tbb::filter_mode / tbb::parallel_pipeline API (not the deprecated tbb::filter).
#ifndef TBB_VERSION_MAJOR
#  define TBB_VERSION_MAJOR 2021
#endif
#ifndef TBB_VERSION_MINOR
#  define TBB_VERSION_MINOR 0
#endif
#ifndef TBB_INTERFACE_VERSION
#  define TBB_INTERFACE_VERSION 12000
#endif
