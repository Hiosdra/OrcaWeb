#pragma once
// Stub Freetype headers for WASM — font rendering is not needed for slicing.
#include <cstddef>

typedef unsigned char  FT_Byte;
typedef signed long    FT_Fixed;
typedef signed int     FT_Int;
typedef unsigned int   FT_UInt;
typedef signed long    FT_Long;
typedef unsigned long  FT_ULong;
typedef signed short   FT_Short;
typedef unsigned short FT_UShort;
typedef int            FT_Error;
typedef void*          FT_Pointer;
typedef size_t         FT_Offset;
typedef signed long    FT_Pos;
typedef char           FT_String;

struct FT_LibraryRec_;
struct FT_FaceRec_;
struct FT_SizeRec_;
struct FT_GlyphSlotRec_;
struct FT_CharMapRec_;
typedef FT_LibraryRec_*  FT_Library;
typedef FT_FaceRec_*     FT_Face;
typedef FT_SizeRec_*     FT_Size;
typedef FT_GlyphSlotRec_* FT_GlyphSlot;
typedef FT_CharMapRec_*  FT_CharMap;

struct FT_Vector { FT_Pos x, y; };
struct FT_BBox   { FT_Pos xMin, yMin, xMax, yMax; };
struct FT_Bitmap {
    unsigned int rows, width, pitch;
    unsigned char* buffer;
    unsigned short num_grays;
    unsigned char pixel_mode, palette_mode;
    void* palette;
};
struct FT_Outline {
    short n_contours, n_points;
    FT_Vector* points;
    char* tags;
    short* contours;
    int flags;
};
struct FT_Glyph_Metrics {
    FT_Pos width, height, horiBearingX, horiBearingY, horiAdvance,
           vertBearingX, vertBearingY, vertAdvance;
};
struct FT_GlyphSlotRec_ {
    FT_Library library; FT_Face face;
    FT_GlyphSlotRec_* next;
    FT_UInt glyph_index;
    FT_Glyph_Metrics metrics;
    FT_Fixed linearHoriAdvance, linearVertAdvance;
    FT_Vector advance;
    int format;
    FT_Bitmap bitmap;
    FT_Int bitmap_left, bitmap_top;
    FT_Outline outline;
    FT_UInt num_subglyphs;
    void* subglyphs;
    void* control_data; long control_len;
    FT_Pos lsb_delta, rsb_delta;
    void* other;
    void* internal;
};
struct FT_Size_Metrics {
    FT_UShort x_ppem, y_ppem;
    FT_Fixed x_scale, y_scale;
    FT_Pos ascender, descender, height, max_advance;
};
struct FT_SizeRec_ { FT_Face face; FT_Size_Metrics metrics; void* internal; };

struct FT_FaceRec_ {
    FT_Long num_faces, face_index;
    FT_Long face_flags, style_flags;
    FT_Long num_glyphs;
    FT_String* family_name; FT_String* style_name;
    FT_Int num_fixed_sizes; void* available_sizes;
    FT_Int num_charmaps; FT_CharMap* charmaps;
    void* generic;
    FT_BBox bbox;
    FT_UShort units_per_EM;
    FT_Short ascender, descender, height, max_advance_width, max_advance_height,
             underline_position, underline_thickness;
    FT_GlyphSlot glyph; FT_Size size; FT_CharMap charmap;
    void* driver; void* memory; void* stream;
    void* sizes_list;
    void* autohint; void* extensions; void* internal;
};
struct FT_LibraryRec_ { void* memory; };

#define FT_LOAD_DEFAULT          0
#define FT_LOAD_NO_HINTING       2
#define FT_LOAD_RENDER           4
#define FT_LOAD_NO_BITMAP        8
#define FT_PIXEL_MODE_GRAY       2
#define FT_FACE_FLAG_SCALABLE    (1L <<  0)
#define FT_FACE_FLAG_FIXED_WIDTH (1L <<  1)
#define FT_GLYPH_FORMAT_OUTLINE  0x6f75746cUL
#define FT_GLYPH_FORMAT_BITMAP   0x62697473UL
#define FT_STYLE_FLAG_ITALIC     (1 << 0)
#define FT_STYLE_FLAG_BOLD       (1 << 1)

inline FT_Error FT_Init_FreeType(FT_Library*)           { return 1; }
inline FT_Error FT_Done_FreeType(FT_Library)            { return 0; }
inline FT_Error FT_New_Face(FT_Library,const char*,FT_Long,FT_Face*) { return 1; }
inline FT_Error FT_New_Memory_Face(FT_Library,const FT_Byte*,FT_Long,FT_Long,FT_Face*) { return 1; }
inline FT_Error FT_Done_Face(FT_Face)                   { return 0; }
inline FT_Error FT_Set_Pixel_Sizes(FT_Face,FT_UInt,FT_UInt) { return 1; }
inline FT_Error FT_Set_Char_Size(FT_Face,FT_F26Dot6,FT_F26Dot6,FT_UInt,FT_UInt) { return 1; }
inline FT_UInt  FT_Get_Char_Index(FT_Face,FT_ULong)     { return 0; }
inline FT_Error FT_Load_Glyph(FT_Face,FT_UInt,FT_Int32) { return 1; }
inline FT_Error FT_Load_Char(FT_Face,FT_ULong,FT_Int32) { return 1; }
inline FT_Error FT_Render_Glyph(FT_GlyphSlot,int)       { return 1; }
inline void     FT_Set_Transform(FT_Face,void*,FT_Vector*) {}
inline FT_Error FT_Get_Glyph(FT_GlyphSlot,void**)       { return 1; }
inline void     FT_Done_Glyph(void*)                     {}

typedef signed long FT_F26Dot6;
typedef signed long FT_F16Dot6;
typedef signed long FT_26Dot6;
