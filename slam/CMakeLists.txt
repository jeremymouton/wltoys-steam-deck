# slam_pipe — stdin gray8 frames -> stella_vslam -> NDJSON stdout.
#
# Deps (stella_vslam, g2o, FBoW, Eigen, OpenCV, yaml-cpp) are located via
# CMAKE_PREFIX_PATH — no platform-specific paths in here. Used by both the
# Mac dev build (slam/build-mac.sh) and the Linux CI bundle build.

cmake_minimum_required(VERSION 3.16)
project(slam_pipe LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

if(NOT CMAKE_BUILD_TYPE)
    set(CMAKE_BUILD_TYPE Release)
endif()

find_package(stella_vslam REQUIRED)
find_package(OpenCV REQUIRED COMPONENTS core)

add_executable(slam_pipe slam_pipe.cc)
target_link_libraries(slam_pipe PRIVATE stella_vslam::stella_vslam opencv_core)

# stella's exported interface references FBoW by bare name ("fbow"), which
# resolves via link_directories() only. Its installed config hardcodes the
# build-time prefix, so derive the real lib dir from the imported target
# location instead — keeps the build correct after the prefix is relocated.
if(TARGET fbow::fbow)
    get_target_property(_fbow_loc fbow::fbow IMPORTED_LOCATION_RELEASE)
    if(NOT _fbow_loc)
        get_target_property(_fbow_loc fbow::fbow IMPORTED_LOCATION)
    endif()
    if(_fbow_loc)
        get_filename_component(_fbow_dir "${_fbow_loc}" DIRECTORY)
        target_link_directories(slam_pipe PRIVATE "${_fbow_dir}")
    endif()
endif()
