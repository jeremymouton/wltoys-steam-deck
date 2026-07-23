#!/bin/bash
# slam/relocate.sh — recursive Mach-O relocation walker: the macOS Apple-Silicon
# analogue of the Linux bundle's `patchelf --set-rpath '$ORIGIN'`.
#
# Given an executable and a bundle lib dir, it copies EVERY non-system dylib the
# binary transitively needs into <libdir>, rewrites all install names to
# @rpath/<basename>, gives the executable ONE @loader_path/lib rpath (so @rpath
# resolves to the bundle for the whole process), strips leftover absolute host
# rpaths, and re-signs ad-hoc after every edit — mandatory on arm64, where any
# install_name_tool edit invalidates the linker signature and dyld then refuses
# to map the file ("killed" with no output).
#
# Sourceable (defines `relocate_bundle`) AND runnable standalone:
#     source relocate.sh; relocate_bundle <exe> <libdir> [search dir ...]
#     ./relocate.sh              <exe> <libdir> [search dir ...]
#
# bash 3.2 SAFE. macOS ships /bin/bash 3.2.57, which has NO associative arrays
# (`declare -A`). The research sketch used `declare -A seen`; here the "seen" set
# is a space-delimited string membership test instead (dylib basenames never
# contain spaces). Indexed arrays ARE 3.2-safe and are used for the queue and
# the resolver search path.

# relocate_bundle <executable> <bundle_libdir> [extra search dir ...]
relocate_bundle() {
    local exe="$1" libdir="$2"
    shift 2
    mkdir -p "$libdir"

    # SEARCH: dirs used to resolve @rpath/@loader_path/@executable_path refs to a
    # real file. Seeded with the bundle libdir + caller-supplied dirs, and grown
    # as absolute deps reveal new keg dirs — this is what lets us follow e.g.
    # protobuf's `@rpath/libutf8_validity.dylib` sibling, which lives in
    # protobuf's own lib dir (not in any caller-passed search dir).
    local SEARCH=("$libdir" "$@")
    local SEEN=" "            # space-delimited basename membership set
    local QUEUE=("$exe")      # work list of Mach-O files to rewrite

    _in_search() {
        local d
        for d in ${SEARCH[@]+"${SEARCH[@]}"}; do
            [ "$d" = "$1" ] && return 0
        done
        return 1
    }
    _add_search() { _in_search "$1" || SEARCH+=("$1"); }
    _real() {
        local b="$1" d
        for d in ${SEARCH[@]+"${SEARCH[@]}"}; do
            [ -f "$d/$b" ] && { printf '%s\n' "$d/$b"; return 0; }
        done
        return 1
    }
    # Delete every ABSOLUTE (host) LC_RPATH from a file; keep relative
    # (@loader_path/@rpath/@executable_path) ones. Absolute rpaths are the real
    # host-path leak: they are what @rpath deps resolve against, so a stale
    # ~/.cache or /opt/homebrew rpath could shadow the bundle on the dev machine.
    _strip_host_rpaths() {
        local file="$1" rp
        while IFS= read -r rp; do
            case "$rp" in
                /*) install_name_tool -delete_rpath "$rp" "$file" 2>/dev/null || true ;;
            esac
        done < <(otool -l "$file" | awk '$1=="cmd" && $2=="LC_RPATH"{f=1} f && $1=="path"{print $2; f=0}')
    }
    _sign() {
        codesign --force -s - "$1" 2>/dev/null || { echo "relocate: codesign failed: $1" >&2; return 1; }
    }

    local f dep base src dir
    while [ ${#QUEUE[@]} -gt 0 ]; do
        f="${QUEUE[0]}"
        QUEUE=("${QUEUE[@]:1}")   # pop front (empty-safe on 1-element queue)
        while IFS= read -r dep; do
            [ -n "$dep" ] || continue
            case "$dep" in
                /usr/lib/*|/System/*) continue ;;      # system libs — never bundle
            esac
            base="${dep##*/}"
            case "$dep" in
                @rpath/*|@loader_path/*|@executable_path/*)
                    src="$(_real "$base")" || { echo "relocate: WARN cannot resolve $dep (from $f)" >&2; continue; }
                    ;;
                /*)
                    src="$dep"
                    [ -f "$src" ] || { echo "relocate: WARN missing $src (from $f)" >&2; continue; }
                    dir="$(cd "$(dirname "$src")" && pwd)"
                    _add_search "$dir"
                    ;;
                *)
                    src="$(_real "$base")" || { echo "relocate: WARN cannot resolve $dep (from $f)" >&2; continue; }
                    ;;
            esac
            case "$SEEN" in
                *" $base "*) : ;;                      # already bundled
                *)
                    SEEN="$SEEN$base "
                    if [ ! -f "$libdir/$base" ]; then
                        cp -L "$src" "$libdir/$base"
                        chmod u+w "$libdir/$base"
                    fi
                    install_name_tool -id "@rpath/$base" "$libdir/$base"
                    QUEUE+=("$libdir/$base")
                    ;;
            esac
            # rewrite this dependent's reference (skip if already @rpath/<base>)
            [ "$dep" = "@rpath/$base" ] || install_name_tool -change "$dep" "@rpath/$base" "$f"
        done < <(otool -L "$f" | tail -n +2 | awk '{print $1}')
        _strip_host_rpaths "$f"
        _sign "$f" || return 1
    done

    # ONE rpath on the executable makes @rpath resolve to the bundle for every
    # dylib in the process. Guard against a duplicate LC_RPATH on re-runs.
    otool -l "$exe" | grep -q "@loader_path/lib" \
        || install_name_tool -add_rpath "@loader_path/lib" "$exe"
    _sign "$exe" || return 1
}

# Standalone entry point (only when executed, not when sourced).
if [ "${BASH_SOURCE[0]}" = "${0}" ]; then
    set -euo pipefail
    if [ "$#" -lt 2 ]; then
        echo "usage: $(basename "$0") <executable> <bundle_libdir> [search dir ...]" >&2
        exit 2
    fi
    relocate_bundle "$@"
    echo "relocate: done — $1 (libs in $2)"
fi
