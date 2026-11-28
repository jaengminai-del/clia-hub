"""Run with PYTHONPATH=crawler-py python -m unittest discover -s tests -p test_pdp_review.py."""
import json
import re
import tempfile
import unittest
from pathlib import Path
from zipfile import ZipFile

from content_gen import generate
from content_gen.slices import _review_html, render
from coverage_check import check


class ReviewMappingTest(unittest.TestCase):
    def test_nested_missing_evidence_has_its_own_key(self):
        html = """
          <div class="c-wrapper ST0001"><h2>Parent headline</h2>
            <div class="c-wrapper ST0001">
              <p>Missing child caption</p>
              <img src="https://example.test/child.jpg">
            </div>
            <div class="c-wrapper"><p>Unclassified child caption</p></div>
          </div>
        """
        coverage = check(html, {"sections": [{"text": "Parent headline"}]})
        child = next(x for x in coverage["missing_texts"] if x["text"] == "Missing child caption")
        unknown = next(x for x in coverage["missing_texts"] if x["text"] == "Unclassified child caption")
        self.assertRegex(child["source_key"], r"^ST0001:1:")
        self.assertEqual(coverage["missing_images"][0]["source_key"], child["source_key"])
        self.assertIsNone(unknown["source_key"])

    def test_saved_edit_filter_preserves_detail_and_removes_market_blocks(self):
        html = """<div class="lg-container">
          <section class="lg-listing">Merchant terms</section>
          <section class="lg-gallery"><div class="lg-gallery-main">Gallery chrome</div></section>
          <section><img src="https://example.test/gallery.jpg">Fallback hero</section>
          <section><p>Saved PDP text</p><img src="https://example.test/detail.jpg"><img src="https://example.test/gallery.jpg"></section>
        </div>"""
        preview = _review_html(html, {"gallery.jpg"})
        for excluded in ("Merchant terms", "Gallery chrome", "Fallback hero", "gallery.jpg"):
            self.assertNotIn(excluded, preview)
        self.assertIn("Saved PDP text", preview)
        self.assertIn("detail.jpg", preview)

    def test_real_gallery_cut_moves_spec_into_same_authoritative_render(self):
        key = "PD0008:12:abcdef0123456789"
        gallery = '<section class="lg-gallery" style="height:755px">Leading gallery</section>'
        detail = ''.join(f'<section style="height:755px">Detail {i}</section>' for i in range(11))
        for tagged in (True, False):
            tag = f' data-pdp-section="{key}"' if tagged else ''
            table = (f'<section{tag} style="height:755px"><table class="lg-spec-table">'
                     '<tr><td>Screen width</td><td>42 cm</td></tr></table></section>')
            html = '<style>.lg-container{width:400px}</style><div class="lg-container">' + gallery + detail + table + '</div>'
            with self.subTest(tagged=tagged), tempfile.TemporaryDirectory() as tmp:
                export = Path(tmp, "classic.zip")
                authority = Path(tmp, "pdp.zip")
                options = {"html": html, "medium": "shopee_lazada", "viewportWidth": 400, "outputWidth": 400}
                render(options, export)
                render({**options, "review": True}, authority)
                with ZipFile(export) as old, ZipFile(authority) as new:
                    old_manifest = json.loads(old.read("pdp-manifest.json"))
                    manifest = json.loads(new.read("pdp-manifest.json"))
                    self.assertEqual(len(old_manifest["images"]), 13)
                    if tagged:
                        self.assertEqual(old_manifest["spec_sections"][key][0]["slice"], 13)
                    self.assertEqual(len(manifest["images"]), 12)
                    spec, = manifest["spec_tables"]
                    self.assertEqual(spec["rows"], [["Screen width", "42 cm"]])
                    self.assertEqual(spec["sourceKeys"], [key] if tagged else [])
                    self.assertEqual(spec["regions"][0]["slice"], 12)
                    self.assertNotIn("Leading gallery", new.read("pdp-texts.txt").decode())

    def test_mapping_preserves_export_pixels_slice_boundaries_and_first_twelve(self):
        mirror = {
            "sections": [
                {
                    "component_id": "PD0008",
                    "source_keys": [f"PD0008:{index}:{index:016x}"],
                    "specs": [{"label": f"Group {index} spec {j} " + "Extra detail " * 5,
                               "value": f"Value {index} {j} " + "Value detail " * 5} for j in range(12)],
                }
                for index in range(22)
            ]
        }
        listing = {"fields": {"promotion": "Merchant promotion"}}
        plain = generate(mirror, "shopee_lazada", fragment=True, listing=listing)
        tagged = generate(mirror, "shopee_lazada", fragment=True, listing=listing, map_sections=True)
        self.assertIn("data-pdp-section", tagged)
        self.assertIn("Merchant promotion", plain)
        self.assertEqual(re.sub(r' data-pdp-section="[^"]*"', "", tagged), plain)
        with tempfile.TemporaryDirectory() as tmp:
            paths = [Path(tmp, f"{i}.zip") for i in range(2)]
            for content, output in zip((plain, tagged), paths):
                render({"html": content, "medium": "shopee_lazada", "slices": 13, "name": "parity"}, output)
            with ZipFile(paths[0]) as baseline, ZipFile(paths[1]) as mapped:
                names = baseline.namelist()
                self.assertEqual(names, mapped.namelist())
                a = json.loads(baseline.read("parity-manifest.json"))
                b = json.loads(mapped.read("parity-manifest.json"))
                self.assertGreater(len(b["images"]), 12)
                self.assertGreater(len(b["sections"]), 0)
                self.assertEqual(a["images"], b["images"])
                self.assertEqual(a["total_height_css"], b["total_height_css"])
                for name in names:
                    if name != "parity-manifest.json":
                        self.assertEqual(baseline.read(name), mapped.read(name), name)

    def test_bundle_tables_keep_component_scope_with_reused_source_keys(self):
        key = "PD0008:1:abcdef0123456789"
        mirror = {
            "sections": [
                {"component_id": "PD0008", "source_keys": [key], "bundle_part": part,
                 "specs": [{"label": "Screen width", "value": width}]}
                for part, width in [(1, "42 cm"), (2, "52 cm")]
            ]
        }
        mapped = generate(mirror, "shopee_lazada", fragment=True, map_sections=True)
        classic = generate(mirror, "shopee_lazada", fragment=True)
        self.assertEqual(re.sub(r' data-pdp-(?:section|part)="[^"]*"', "", mapped), classic)
        with tempfile.TemporaryDirectory() as tmp:
            output = Path(tmp, "bundle.zip")
            render({"html": mapped, "medium": "shopee_lazada", "name": "bundle", "review": True}, output)
            with ZipFile(output) as archive:
                manifest = json.loads(archive.read("bundle-manifest.json"))
        self.assertEqual([(tab["part"], tab["sourceKeys"], tab["rows"]) for tab in manifest["spec_tables"]], [
            (1, [key], [["Screen width", "42 cm"]]), (2, [key], [["Screen width", "52 cm"]])
        ])
        for part in (1, 2):
            self.assertTrue(manifest["sections"][f"part:{part}:{key}"])
