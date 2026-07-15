#pragma once
#include "freetype.h"
typedef void* FT_Glyph;
typedef void* FT_BitmapGlyph;
typedef void* FT_OutlineGlyph;
inline FT_Error FT_Glyph_Get_CBox(FT_Glyph, FT_UInt, FT_BBox*) { return 1; }
inline FT_Error FT_Glyph_To_Bitmap(FT_Glyph*, int, FT_Vector*, int) { return 1; }
