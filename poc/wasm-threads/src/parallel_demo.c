// PoC: real WASM multithreading (pthreads + SharedArrayBuffer) via Emscripten.
// Companion to mkdocs-docs/adr/adr-007-tbb-stubs.md — see poc/wasm-threads/README.md.
//
// Computes a CPU-bound, embarrassingly-parallel reduction (the same shape as the
// per-layer/per-object work libslic3r hands to TBB) both sequentially and split
// across N real pthreads, so the two paths can be timed and cross-checked.

#include <emscripten.h>
#include <emscripten/threading.h>
#include <pthread.h>
#include <stdlib.h>
#include <math.h>

static double workload_term(long i) {
    double x = (double)i;
    return sin(x) * cos(x) + sqrt(x + 1.0);
}

EMSCRIPTEN_KEEPALIVE
double run_sequential(long n) {
    double sum = 0.0;
    for (long i = 0; i < n; i++) {
        sum += workload_term(i);
    }
    return sum;
}

typedef struct {
    long start;
    long end;
    double partial_sum;
    int thread_created;
} chunk_t;

static void *worker(void *arg) {
    chunk_t *c = (chunk_t *)arg;
    double sum = 0.0;
    for (long i = c->start; i < c->end; i++) {
        sum += workload_term(i);
    }
    c->partial_sum = sum;
    return NULL;
}

EMSCRIPTEN_KEEPALIVE
double run_parallel(long n, int num_threads) {
    if (num_threads < 1) num_threads = 1;

    pthread_t *threads = malloc(sizeof(pthread_t) * num_threads);
    chunk_t *chunks = malloc(sizeof(chunk_t) * num_threads);
    if (!threads || !chunks) {
        free(threads);
        free(chunks);
        return run_sequential(n);
    }

    long chunk_size = n / num_threads;

    for (int i = 0; i < num_threads; i++) {
        chunks[i].start = i * chunk_size;
        chunks[i].end = (i == num_threads - 1) ? n : (i + 1) * chunk_size;
        chunks[i].partial_sum = 0.0;
        if (pthread_create(&threads[i], NULL, worker, &chunks[i]) == 0) {
            chunks[i].thread_created = 1;
        } else {
            chunks[i].thread_created = 0;
            worker(&chunks[i]);
        }
    }

    double total = 0.0;
    for (int i = 0; i < num_threads; i++) {
        if (chunks[i].thread_created) {
            pthread_join(threads[i], NULL);
        }
        total += chunks[i].partial_sum;
    }

    free(threads);
    free(chunks);
    return total;
}

EMSCRIPTEN_KEEPALIVE
int get_hardware_concurrency(void) {
    return emscripten_num_logical_cores();
}
