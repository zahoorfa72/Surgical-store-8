import os
import sys
import unittest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "backend")))
from supabase_store import _matches


class SupabaseDocumentQueryTests(unittest.TestCase):
    def test_case_insensitive_regex_matches_exact_product_name(self):
        product = {"name": "Sterile Gloves", "barcode": "", "deleted": False}
        query = {
            "$or": [
                {"name": {"$regex": r"^sterile gloves$", "$options": "i"}},
                {"barcode": "123"},
            ],
            "deleted": {"$ne": True},
        }
        self.assertTrue(_matches(product, query))

    def test_regex_does_not_match_an_unrelated_product(self):
        product = {"name": "Surgical Mask", "barcode": "", "deleted": False}
        query = {
            "$or": [
                {"name": {"$regex": r"^sterile gloves$", "$options": "i"}},
                {"barcode": "123"},
            ],
            "deleted": {"$ne": True},
        }
        self.assertFalse(_matches(product, query))

    def test_duplicate_lookup_still_excludes_deleted_products(self):
        product = {"name": "Sterile Gloves", "barcode": "", "deleted": True}
        query = {
            "$or": [
                {"name": {"$regex": r"^sterile gloves$", "$options": "i"}},
                {"barcode": "123"},
            ],
            "deleted": {"$ne": True},
        }
        self.assertFalse(_matches(product, query))

    def test_invalid_regex_fails_closed(self):
        product = {"name": "Sterile Gloves"}
        self.assertFalse(_matches(product, {"name": {"$regex": "["}}))


if __name__ == "__main__":
    unittest.main()
