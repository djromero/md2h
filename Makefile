BIN_DIR ?= $(HOME)/.local/bin
RESOURCE_DIR ?= $(HOME)/.local/md2h
CODEX_SKILLS_DIR ?= $(HOME)/.agents/skills

SCRIPTS := md2h markdown-to-html.js
RESOURCES := glow-dark.json glow-light.json

.PHONY: install install-skills test

test:
	./test.sh

install:
	install -d "$(BIN_DIR)" "$(RESOURCE_DIR)"
	install -m 755 $(SCRIPTS) "$(BIN_DIR)"
	install -m 644 $(RESOURCES) "$(RESOURCE_DIR)"
	@case ":$$PATH:" in *":$(BIN_DIR):"*) ;; *) printf '%s\n' 'Hint: add ~/.local/bin to your PATH, e.g. export PATH="$$HOME/.local/bin:$$PATH"' ;; esac
	@printf '%s\n' 'Reminder: install the optional Codex skill with `make install-skills`.'

install-skills:
	@if [ ! -d "skills/md2h-team-slides" ]; then printf '%s\n' 'Failed: skill source directory not found: skills/md2h-team-slides'; exit 1; fi
	@if [ -z "$(CODEX_SKILLS_DIR)" ] || [ "$(CODEX_SKILLS_DIR)" = "/" ]; then printf '%s\n' 'Failed: CODEX_SKILLS_DIR must be a non-root directory'; exit 1; fi
	install -d "$(CODEX_SKILLS_DIR)"
	rm -rf "$(CODEX_SKILLS_DIR)/md2h-team-slides"
	cp -R "skills/md2h-team-slides" "$(CODEX_SKILLS_DIR)/"
	@printf 'Installed md2h-team-slides successfully to %s/md2h-team-slides\n' "$(CODEX_SKILLS_DIR)"
