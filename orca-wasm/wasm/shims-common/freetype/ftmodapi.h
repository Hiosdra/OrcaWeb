#pragma once
#include "freetype.h"
typedef void* FT_Module;
inline FT_Error FT_Add_Default_Modules(FT_Library) { return 0; }
