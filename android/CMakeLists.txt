cmake_minimum_required(VERSION 3.10)
project(otaupdates C)

set(CMAKE_C_STANDARD 99)
set(CMAKE_POSITION_INDEPENDENT_CODE ON)

set(BZ2_SOURCES
  src/main/cpp/bzip2/blocksort.c
  src/main/cpp/bzip2/bzlib.c
  src/main/cpp/bzip2/compress.c
  src/main/cpp/bzip2/crctable.c
  src/main/cpp/bzip2/decompress.c
  src/main/cpp/bzip2/huffman.c
  src/main/cpp/bzip2/randtable.c
)

add_library(otaupdates SHARED
  src/main/cpp/bspatch.c
  src/main/cpp/jni_bridge.c
  ${BZ2_SOURCES}
)

target_include_directories(otaupdates PRIVATE
  src/main/cpp
  src/main/cpp/bzip2
)

target_compile_options(otaupdates PRIVATE
  -O2
  -Wno-unused-parameter
  -Wno-implicit-function-declaration
)

find_library(log-lib log)
target_link_libraries(otaupdates ${log-lib})
