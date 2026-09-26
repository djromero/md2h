BIN_DIR ?= $(HOME)/.local/bin
RESOURCE_DIR ?= $(HOME)/.local/md2h

SCRIPTS := md2h markdown-to-html.js
RESOURCES := glow-dark.json glow-light.json

.PHONY: install test

test:
	./test.sh

install:
	install -d "$(BIN_DIR)" "$(RESOURCE_DIR)"
	install -m 755 $(SCRIPTS) "$(BIN_DIR)"
	install -m 644 $(RESOURCES) "$(RESOURCE_DIR)"
	@case ":$$PATH:" in *":$(BIN_DIR):"*) ;; *) printf '%s\n' 'Hint: add ~/.local/bin to your PATH, e.g. export PATH="$$HOME/.local/bin:$$PATH"' ;; esac
