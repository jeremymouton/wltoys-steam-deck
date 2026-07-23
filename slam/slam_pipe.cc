// slam_pipe — stdin gray8 1280x720 frames -> stella_vslam monocular -> NDJSON stdout.
//
// Usage: slam_pipe config.yaml vocab.fbow [map_in] [map_out]
//   map_in  — optional map database to load and relocalize into ("" to skip;
//             silently starts fresh if the file does not exist)
//   map_out — optional path to save the map database on clean exit ("" to skip)
//
// Protocol: one JSON object per frame on stdout:
//   {"n":123,"state":"Tracking","ms":11.2,"pose":[r00,r01,r02,tx,...,r22,tz]}
// "pose" is the 3x4 top of the world<-camera matrix, row-major; present only
// while tracking. Every 25th frame (1 Hz at 25 fps) a map snapshot is added:
//   "lms":[x,y,z,x,y,z,...] (landmarks), "kfs":[x,y,z,...] (keyframe positions).
//
// All logging goes to stderr — stdout is pure NDJSON for the Node consumer.

#include <stella_vslam/system.h>
#include <stella_vslam/config.h>
#include <stella_vslam/publish/map_publisher.h>
#include <stella_vslam/publish/frame_publisher.h>
#include <stella_vslam/data/landmark.h>
#include <stella_vslam/data/keyframe.h>
#include <spdlog/spdlog.h>
#include <spdlog/sinks/stdout_color_sinks.h> // stella vendors spdlog 1.3.1: stderr_color_mt lives here
#include <opencv2/core.hpp>

#include <cstdio>
#include <memory>
#include <set>
#include <vector>
#include <sys/stat.h>

static bool file_exists(const char* path) {
    struct stat st;
    return path && path[0] && ::stat(path, &st) == 0;
}

int main(int argc, char** argv) {
    // CRITICAL: route spdlog to stderr BEFORE constructing config/system —
    // the default sink writes to stdout and would corrupt the NDJSON stream.
    spdlog::set_default_logger(spdlog::stderr_color_mt("slam_pipe"));

    if (argc < 3) {
        std::fprintf(stderr, "usage: %s config.yaml vocab.fbow [map_in] [map_out]\n", argv[0]);
        return 2;
    }
    const char* map_in  = (argc > 3) ? argv[3] : "";
    const char* map_out = (argc > 4) ? argv[4] : "";

    constexpr int W = 1280, H = 720;
    constexpr double FPS = 25.0;
    constexpr uint64_t SNAPSHOT_EVERY = 25; // frames between lms/kfs dumps (1 Hz)
    // Snapshot size caps — the consumer draws a 300x300 minimap, so past a few
    // thousand points extra data is pure cost (map size grows unbounded over a
    // long drive; uncapped, a 100k-landmark snapshot is a ~2MB NDJSON line that
    // costs the Node side ~10ms/s to parse). Stride subsampling over the
    // unordered_map iteration order is effectively a uniform random sample.
    constexpr size_t LMS_CAP = 2000;
    constexpr size_t KFS_CAP = 600; // Node chains kfs O(n^2); 600 keeps that ~2ms

    auto cfg  = std::make_shared<stella_vslam::config>(argv[1]);
    auto slam = std::make_shared<stella_vslam::system>(cfg, argv[2]);

    const bool resume = file_exists(map_in);
    if (map_in[0] && !resume) {
        spdlog::warn("map_in '{}' not found — starting fresh", map_in);
    }
    if (resume) {
        if (!slam->load_map_database(map_in)) {
            spdlog::error("failed to load map '{}'", map_in);
            return 1;
        }
        spdlog::info("loaded map '{}' — starting in Lost, awaiting relocalization", map_in);
    }
    slam->startup(!resume); // startup(false) => keep loaded map, relocalize into it

    auto mp = slam->get_map_publisher();
    auto fp = slam->get_frame_publisher();

    std::vector<uint8_t> buf(static_cast<size_t>(W) * H); // gray8: 921600 B/frame
    uint64_t n = 0;
    for (;; ++n) {
        const size_t got = std::fread(buf.data(), 1, buf.size(), stdin);
        if (got != buf.size()) { // short read = upstream pipe closed; clean EOF
            if (got != 0) {
                spdlog::info("partial frame ({} B) at n={} — treating as EOF", got, n);
            }
            break;
        }
        cv::Mat img(H, W, CV_8UC1, buf.data());
        const auto pose = slam->feed_monocular_frame(img, n / FPS); // world<-cam

        std::printf("{\"n\":%llu,\"state\":\"%s\",\"ms\":%.1f",
                    static_cast<unsigned long long>(n),
                    fp->get_tracking_state().c_str(),
                    fp->get_tracking_time_elapsed_ms());
        if (pose) {
            const auto& M = *pose; // emit 3x4 row-major (bottom 0001 row dropped)
            std::printf(",\"pose\":[");
            for (int r = 0; r < 3; ++r) {
                for (int c = 0; c < 4; ++c) {
                    std::printf("%s%.6f", (r || c) ? "," : "", M(r, c));
                }
            }
            std::printf("]");
        }
        if (n % SNAPSHOT_EVERY == 0) {
            std::vector<std::shared_ptr<stella_vslam::data::landmark>> lms;
            std::set<std::shared_ptr<stella_vslam::data::landmark>> local_lms;
            mp->get_landmarks(lms, local_lms);
            const size_t lm_stride = lms.size() > LMS_CAP ? (lms.size() + LMS_CAP - 1) / LMS_CAP : 1;
            std::printf(",\"lms\":[");
            bool first = true;
            size_t li = 0;
            for (const auto& lm : lms) {
                if (!lm || lm->will_be_erased()) {
                    continue;
                }
                if (li++ % lm_stride) {
                    continue;
                }
                const auto p = lm->get_pos_in_world();
                std::printf("%s%.3f,%.3f,%.3f", first ? "" : ",", p(0), p(1), p(2));
                first = false;
            }
            std::vector<std::shared_ptr<stella_vslam::data::keyframe>> kfs;
            mp->get_keyframes(kfs);
            const size_t kf_stride = kfs.size() > KFS_CAP ? (kfs.size() + KFS_CAP - 1) / KFS_CAP : 1;
            std::printf("],\"kfs\":[");
            first = true;
            size_t ki = 0;
            for (const auto& kf : kfs) {
                if (!kf) {
                    continue;
                }
                if (ki++ % kf_stride) {
                    continue;
                }
                const auto t = kf->get_trans_wc();
                std::printf("%s%.3f,%.3f,%.3f", first ? "" : ",", t(0), t(1), t(2));
                first = false;
            }
            std::printf("]");
        }
        std::printf("}\n");
        std::fflush(stdout);
    }

    spdlog::info("EOF after {} frames", n);
    slam->shutdown(); // stop background mapping/BA threads before saving
    if (map_out[0]) {
        if (slam->save_map_database(map_out)) {
            spdlog::info("map saved to '{}'", map_out);
        }
        else {
            spdlog::error("failed to save map to '{}'", map_out);
        }
    }
    return 0;
}
