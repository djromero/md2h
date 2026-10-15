#!/usr/bin/env bash
set -euo pipefail

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
test_dir=$(mktemp -d "${TMPDIR:-/tmp}/md2h-test.XXXXXX")
trap 'rm -rf -- "$test_dir"' EXIT

source_dir="$test_dir/source"
output_dir="$test_dir/output"
mkdir -p "$source_dir/more" "$output_dir" "$test_dir/bin" "$test_dir/tmp"

cat >"$source_dir/A.md" <<'EOF'
# A

[B](B)
[C](more/C#details)
[space](space%20name.md)
[amp](A%26B.md?x=1&y=2#part)
[external](https://example.com/page.md)
[outside](../outside.md)

```markdown
[not a link](ignored.md)
```
EOF

cat >"$source_dir/B.md" <<'EOF'
# B

[A](A)
EOF

cat >"$source_dir/more/C.md" <<'EOF'
# C

## Details

[B](../B)
EOF

cat >"$source_dir/space name.md" <<'EOF'
# Space
EOF

cat >"$source_dir/A&B.md" <<'EOF'
# Ampersand
EOF

cat >"$test_dir/outside.md" <<'EOF'
# Outside
EOF

node "$script_dir/markdown-to-html.js" "$source_dir/A.md" "$output_dir/A.html" --linked >/dev/null

assert_file() {
  if [[ ! -f $1 ]]; then
    printf 'Expected file was not rendered: %s\n' "$1" >&2
    exit 1
  fi
}

assert_contains() {
  local file=$1
  local expected=$2
  if ! grep -Fq -- "$expected" "$file"; then
    printf 'Expected %s to contain: %s\n' "$file" "$expected" >&2
    exit 1
  fi
}

assert_not_contains() {
  local file=$1
  local unexpected=$2
  if grep -Fq -- "$unexpected" "$file"; then
    printf 'Expected %s not to contain: %s\n' "$file" "$unexpected" >&2
    exit 1
  fi
}

assert_occurrences() {
  local file=$1
  local expected_count=$2
  local text=$3
  local actual_count
  actual_count=$(grep -Fc -- "$text" "$file" || true)
  if [[ $actual_count -ne $expected_count ]]; then
    printf 'Expected %s to contain %s occurrences of %s, found %s\n' "$file" "$expected_count" "$text" "$actual_count" >&2
    exit 1
  fi
}

assert_file "$output_dir/A.html"
assert_file "$output_dir/B.html"
assert_file "$output_dir/more/C.html"
assert_file "$output_dir/space name.html"
assert_file "$output_dir/A&B.html"

assert_contains "$output_dir/A.html" 'href="B.html"'
assert_contains "$output_dir/A.html" 'href="more/C.html#details"'
assert_contains "$output_dir/A.html" 'href="space%20name.html"'
assert_contains "$output_dir/A.html" 'href="A%26B.html?x=1&amp;y=2#part"'
assert_contains "$output_dir/A.html" 'href="https://example.com/page.md"'
assert_contains "$output_dir/A.html" 'href="../outside.md"'
assert_contains "$output_dir/B.html" 'href="A.html"'
assert_contains "$output_dir/more/C.html" 'href="../B.html"'

cat >"$source_dir/slides.md" <<'EOF'
#

My **titleless** deck

# Second slide title

Details
EOF

node "$script_dir/markdown-to-html.js" "$source_dir/slides.md" "$output_dir/slides.html" --slides >/dev/null
assert_contains "$output_dir/slides.html" '<title>My titleless deck</title>'

cat >"$source_dir/titleless-subslides.md" <<'EOF'
#

Explore this topic

---

More detail

---

Final detail
EOF

node "$script_dir/markdown-to-html.js" "$source_dir/titleless-subslides.md" "$output_dir/titleless-subslides.html" --slides >/dev/null
assert_contains "$output_dir/titleless-subslides.html" 'slide-subslide-cue slide-subslide-cue-main'
assert_contains "$output_dir/titleless-subslides.html" 'slide-subslide-cue slide-subslide-cue-child'
assert_contains "$output_dir/titleless-subslides.html" 'slide-subslide-cue-child slide-subslide-cue-up'
assert_contains "$output_dir/titleless-subslides.html" 'slide-subslide-cue-child slide-subslide-cue-down'
assert_contains "$output_dir/titleless-subslides.html" 'class="slide-subslide-chevron slide-subslide-chevron-up"'
assert_contains "$output_dir/titleless-subslides.html" 'class="slide-subslide-chevron slide-subslide-chevron-down"'
assert_occurrences "$output_dir/titleless-subslides.html" 2 'class="slide-subslide-chevron slide-subslide-chevron-up"'
assert_occurrences "$output_dir/titleless-subslides.html" 2 'class="slide-subslide-chevron slide-subslide-chevron-down"'
assert_contains "$output_dir/titleless-subslides.html" '@keyframes subslide-cue-float'
assert_contains "$output_dir/titleless-subslides.html" '@media (prefers-reduced-motion: reduce)'
assert_contains "$output_dir/titleless-subslides.html" "deck.classList.add('is-navigation-idle')"
assert_contains "$output_dir/titleless-subslides.html" '}, 1500)'
assert_not_contains "$output_dir/titleless-subslides.html" 'id="slide-vertical-indicator"'

cat >"$source_dir/implicit-cover.md" <<'EOF'
Implicit cover title

# Later heading
EOF

node "$script_dir/markdown-to-html.js" "$source_dir/implicit-cover.md" "$output_dir/implicit-cover.html" --slides >/dev/null
assert_contains "$output_dir/implicit-cover.html" '<title>Implicit cover title</title>'

if [[ -e $output_dir/outside.html || -e $output_dir/ignored.html ]]; then
  printf 'Rendered a Markdown file that should not have been followed\n' >&2
  exit 1
fi

cat >"$test_dir/bin/open" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$@" >"$MD2H_TEST_OPEN_LOG"
EOF
chmod +x "$test_dir/bin/open"
export MD2H_TEST_OPEN_LOG="$test_dir/open.args"
PATH="$test_dir/bin:$PATH" TMPDIR="$test_dir/tmp" "$script_dir/md2h" "$source_dir/A.md" --linked >/dev/null
wrapper_outputs=("$test_dir"/tmp/md2h-A.*/A.html)
if [[ ${#wrapper_outputs[@]} -ne 1 ]]; then
  printf 'Expected md2h --linked to create one temporary entry document\n' >&2
  exit 1
fi
assert_file "${wrapper_outputs[0]}"
assert_file "$(dirname -- "${wrapper_outputs[0]}")/B.html"
printf '%s\n' "${wrapper_outputs[0]}" >"$test_dir/expected-open.args"
cmp "$test_dir/expected-open.args" "$MD2H_TEST_OPEN_LOG"

for browser_flag in --chrome --safari; do
  browser_name='Google Chrome'
  if [[ $browser_flag == --safari ]]; then browser_name=Safari; fi
  browser_output="$output_dir/browser result.html"
  PATH="$test_dir/bin:$PATH" "$script_dir/md2h" "$source_dir/A.md" --slides "$browser_flag" -o "$browser_output" >/dev/null
  printf '%s\n' -a "$browser_name" "$browser_output" >"$test_dir/expected-open.args"
  cmp "$test_dir/expected-open.args" "$MD2H_TEST_OPEN_LOG"
done

"$script_dir/md2h" --help 2>&1 | grep -Fq -- '--linked'
"$script_dir/md2h" --help 2>&1 | grep -Fq -- '--chrome|--safari'
"$script_dir/md2h" --help 2>&1 | grep -Fq -- '--howto <option>'

slides_howto=$("$script_dir/md2h" --howto slides)
grep -Fq -- 'Start each main slide with a level-1 heading' <<<"$slides_howto"
grep -Fq -- '# Welcome' <<<"$slides_howto"
grep -Fq -- 'vertical subslide' <<<"$slides_howto"
grep -Fq -- 'Image paths must be reachable from the' <<<"$slides_howto"
grep -Fq -- 'one image or one diagram per slide' <<<"$slides_howto"

if "$script_dir/md2h" --howto >"$test_dir/howto.out" 2>"$test_dir/howto.err"; then
  printf 'Expected --howto without an option to fail\n' >&2
  exit 1
fi
assert_contains "$test_dir/howto.err" 'md2h: --howto requires an option'

if "$script_dir/md2h" --howto unknown >"$test_dir/howto.out" 2>"$test_dir/howto.err"; then
  printf 'Expected an unknown --howto topic to fail\n' >&2
  exit 1
fi
assert_contains "$test_dir/howto.err" 'available: slides'

printf 'md2h tests passed\n'
