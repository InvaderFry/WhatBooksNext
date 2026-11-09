# Third-party notices

## wordninja word list

`server/src/identify/data/wordninja_words.txt.gz` is the English word-frequency list from
wordninja 2.0.0 (https://github.com/keredson/wordninja), used to split run-together filenames.
It is distributed under the MIT License:

```text
MIT License

Copyright (c) 2017 Derek Anderson

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## npm dependencies used to read files (Milestone 2)

Installed from npm, not bundled in this repository. Each keeps its own licence file in
`node_modules`.

| Package                       | Used for                                  | Licence                                                                                                     |
| ----------------------------- | ----------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `pdfjs-dist` (Mozilla pdf.js) | Reading PDFs and drawing their first page | Apache-2.0                                                                                                  |
| `@napi-rs/canvas`             | Drawing cover thumbnails                  | MIT                                                                                                         |
| `yauzl`                       | Reading EPUB and CBZ (ZIP) files          | MIT                                                                                                         |
| `node-unrar-js`               | Reading CBR (RAR) files, in WebAssembly   | MIT (the bundled UnRAR code is under the unRAR licence, which allows extracting but not creating RAR files) |
