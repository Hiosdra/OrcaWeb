// WASM override: OpenVDB not available — SLA mesh hollowing disabled.
#include "Hollowing.hpp"
#include <libslic3r/ExPolygon.hpp>
#include <array>
#include <functional>
#include <utility>
#include <vector>

namespace Slic3r { namespace sla {

struct Interior { indexed_triangle_set mesh; };

void InteriorDeleter::operator()(Interior *p) { delete p; }

indexed_triangle_set &      get_mesh(Interior &i)       { return i.mesh; }
const indexed_triangle_set &get_mesh(const Interior &i) { return i.mesh; }

bool DrainHole::operator==(const DrainHole &sp) const
{
    return pos.isApprox(sp.pos) && normal.isApprox(sp.normal) &&
           radius == sp.radius && height == sp.height && failed == sp.failed;
}
bool DrainHole::is_inside(const Vec3f &) const { return false; }
bool DrainHole::get_intersections(const Vec3f &, const Vec3f &,
    std::array<std::pair<float, Vec3d>, 2> &) const { return false; }
indexed_triangle_set DrainHole::to_mesh() const { return {}; }

InteriorPtr generate_interior(const TriangleMesh &, const HollowingConfig &,
                               const JobController &) { return {}; }
void hollow_mesh(TriangleMesh &, const HollowingConfig &, int) {}
void hollow_mesh(TriangleMesh &, const Interior &, int) {}
void remove_inside_triangles(TriangleMesh &, const Interior &,
                              const std::vector<bool> &) {}
double get_distance(const Vec3f &, const Interior &) { return 0.; }
void cut_drainholes(std::vector<ExPolygons> &, const std::vector<float> &,
                    float, const sla::DrainHoles &,
                    std::function<void(void)>) {}

}} // namespace Slic3r::sla
