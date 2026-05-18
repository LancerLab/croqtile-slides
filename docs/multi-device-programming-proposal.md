# Multi-Device Programming — Presentation Proposal

## Overview
This slide demonstrates CroqTile's multi-device programming capabilities, including both SPMD (Data Parallel) and MPMD (Task Parallel) patterns.

> **Note:** The MPMD pattern (`parallel.async + mpi.send/recv`) is a speculative/future design. It does NOT currently exist in the real `croqtile/` codebase. Real code uses `inthreads.async` for producer-consumer patterns within a block.

---

## Tab 1: SPMD (Data Parallel)

### Code Example — `distributed_matmul.co`

```choreo
// Same kernel, scaled across nodes
__co__ void matmul(
    global f16 [M, K] lhs,
    global f16 [N, K] rhs,
    global f16 [M, N] output) {

  // Outer: distribute across nodes
  parallel {node_m, node_n}
    by [cdiv(M, NODE_M), cdiv(N, NODE_N)]
    : mpi {

    // Inner: GPU kernel per node
    parallel {bm, bn}
      by [cdiv(NODE_M, WARP_M),
          cdiv(NODE_N, WARP_N)]
      : block {
      mc = mma.fill.f32 0.0f;
      foreach {iv_k} in [cdiv(K, TILE_K)] {
        tma.copy.swiz<128> ...;
        mma.row.row mc, ma, mb;
      }
    }
  }
}
```

### Key Points
- **Few boilerplate for heterogeneous computing:**
  - Kernel launch — compiler generates host dispatch
  - Type conversion & alignments — handled automatically
  - Data partitioning — `parallel-by mpi` splits work across ranks
- `parallel-by mpi` → auto-partitions M dimension across MPI ranks
- Each rank executes the *same* kernel on its data slice
- AllReduce (compiler-generated) → gather output[M, N]

### Execution Diagram (SPMD)
```
┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐
│  Rank 0  │ │  Rank 1  │ │  Rank 2  │ │  Rank 3  │
│ M[0:H/4] │ │M[H/4:H/2]│ │M[H/2:3H/4]│ │M[3H/4:H]│
│  GPU 0   │ │  GPU 1   │ │  GPU 2   │ │  GPU 3   │
└──────────┘ └──────────┘ └──────────┘ └──────────┘
       └───────────┴──────AllReduce──────┴───────────┘
```

---

## Tab 2: MPMD (Task Parallel) — SPECULATIVE/FUTURE DESIGN

### Code Example — `pipeline_mpmd.co`

```choreo
// Different tasks on different nodes
__co__ void pipeline(
    global f16 [M, K] input,
    global f16 [M, N] output) {

  // Stage 1: preprocess on node 0
  parallel.async stage0 by 1 : mpi {
    preprocessed = preprocess(input);
    mpi.send preprocessed => stage1;
  }

  // Stage 2: compute on nodes 1-3
  parallel.async stage1 by 3 : mpi {
    data = mpi.recv <= stage0;
    result = matmul(data, weights);
    mpi.send result => stage2;
  }

  // Stage 3: postprocess on node 4
  parallel.async stage2 by 1 : mpi {
    data = mpi.recv <= stage1;
    output = postprocess(data);
  }
}
```

### Key Points
- **MPMD pattern:** `parallel.async` + `mpi`
  - Different stages run on different node groups
  - `mpi.send/recv` for inter-stage communication
  - Compiler orchestrates pipeline scheduling
- vs. CUDA+MPI: manual rank assignment, buffer management, tag matching
- CroqTile: declare intent, compiler handles communication & scheduling
- Compiler generates `MPI_Isend/Irecv` + pipeline overlap

### Execution Diagram (MPMD Pipeline)
```
┌──────────┐     ┌──────────────────┐     ┌──────────┐
│  Stage 0 │ ──► │   Stage 1 (x3)   │ ──► │  Stage 2 │
│Preprocess│     │   GEMM compute   │     │Postprocess│
│  Node 0  │     │   Nodes 1-3      │     │  Node 4  │
└──────────┘     └──────────────────┘     └──────────┘
```

---

## Design Notes
- The MPMD tab uses speculative syntax not yet implemented in the compiler
- Consider keeping only SPMD for the final presentation (confirmed real usage)
- The `parallel-by mpi` annotation in SPMD is the genuine future direction
