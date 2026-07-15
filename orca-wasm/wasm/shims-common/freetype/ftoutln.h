#pragma once
#include "freetype.h"
struct FT_Outline_Funcs {
    int (*move_to)(const FT_Vector*, void*);
    int (*line_to)(const FT_Vector*, void*);
    int (*conic_to)(const FT_Vector*, const FT_Vector*, void*);
    int (*cubic_to)(const FT_Vector*, const FT_Vector*, const FT_Vector*, void*);
    int shift; FT_Pos delta;
};
inline FT_Error FT_Outline_Decompose(FT_Outline*, const FT_Outline_Funcs*, void*) { return 1; }
inline FT_Error FT_Outline_Get_BBox(FT_Outline*, FT_BBox*) { return 1; }
inline FT_Error FT_Outline_Translate(FT_Outline*, FT_Pos, FT_Pos) { return 0; }
