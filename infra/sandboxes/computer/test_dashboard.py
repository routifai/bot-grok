"""nova-dashboard: numbers computed from files, typed numbers refused, one self-contained page."""

import importlib.machinery
import importlib.util
import json
import re
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
loader = importlib.machinery.SourceFileLoader(
    "nova_dashboard", str(HERE / "nova-dashboard")
)
spec = importlib.util.spec_from_loader(loader.name, loader)
dashboard = importlib.util.module_from_spec(spec)
loader.exec_module(dashboard)

FIXTURE = HERE / "dashboard" / "fixtures" / "sales.spec.json"

CSV = """date,region,revenue,units
2026-01-05,East,100,1
2026-01-20,West,50,2
2026-02-03,East,30,3
2026-02-14,West,20,4
2026-03-01,East,"1,000",5
"""


def embedded(page: str) -> dict:
    raw = re.search(
        r'<script type="application/json" id="nova-dashboard-data">(.*?)</script>',
        page,
        re.S,
    )
    assert raw
    return json.loads(raw.group(1))


class DashboardTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)
        (self.dir / "sales.csv").write_text(CSV, "utf-8")

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def build(self, spec: dict) -> tuple[dict, str]:
        path = self.dir / "spec.json"
        path.write_text(json.dumps(spec), "utf-8")
        result = dashboard.build(path, str(self.dir / "out.html"))
        return result, Path(result["path"]).read_text("utf-8")

    def test_chart_data_comes_from_the_csv(self) -> None:
        result, page = self.build(
            {
                "title": "Sales",
                "source": "sales.csv",
                "charts": [
                    {"title": "By region", "type": "bar", "x": "region", "y": "revenue"}
                ],
            }
        )
        self.assertTrue(result["path"].endswith("out.dashboard.html"))
        [chart] = embedded(page)["charts"]
        self.assertEqual(chart["labels"], ["East", "West"])
        self.assertEqual(chart["datasets"][0]["data"], [1130, 70])
        self.assertIn("Source: sales.csv, revenue summed by region", page)
        self.assertIn("Generated ", page)

    def test_date_buckets_mean_and_split(self) -> None:
        _, page = self.build(
            {
                "source": "sales.csv",
                "charts": [
                    {
                        "title": "Mean",
                        "type": "line",
                        "x": "date",
                        "bucket": "month",
                        "y": "units",
                        "agg": "mean",
                    },
                    {
                        "title": "Split",
                        "type": "bar",
                        "x": "date",
                        "bucket": "quarter",
                        "y": "revenue",
                        "split": "region",
                    },
                ],
            }
        )
        mean, split = embedded(page)["charts"]
        self.assertEqual(mean["labels"], ["Jan 2026", "Feb 2026", "Mar 2026"])
        self.assertEqual(mean["datasets"][0]["data"], [1.5, 3.5, 5])
        self.assertEqual(split["labels"], ["Q1 2026"])
        self.assertEqual(
            {d["label"]: d["data"] for d in split["datasets"]},
            {"East": [1130], "West": [70]},
        )

    def test_kpi_latest_period_and_change(self) -> None:
        _, page = self.build(
            {
                "source": "sales.csv",
                "kpis": [
                    {
                        "label": "Revenue",
                        "value": "revenue",
                        "date": "date",
                        "bucket": "month",
                        "format": {"prefix": "$"},
                    }
                ],
            }
        )
        self.assertIn("$1,000", page)
        self.assertIn("Mar 2026", page)
        self.assertIn("vs Feb 2026", page)
        self.assertEqual(embedded(page)["kpis"][0]["values"], [150, 50, 1000])

    def test_limit_folds_the_rest_into_other(self) -> None:
        _, page = self.build(
            {
                "source": "sales.csv",
                "charts": [
                    {
                        "title": "Top",
                        "type": "bar",
                        "x": "date",
                        "y": "units",
                        "limit": 2,
                    }
                ],
            }
        )
        [chart] = embedded(page)["charts"]
        self.assertEqual(chart["labels"][-1], "Other")
        self.assertEqual(sum(chart["datasets"][0]["data"]), 15)

    def test_typed_numbers_are_refused(self) -> None:
        for bad in (
            {
                "charts": [
                    {
                        "title": "T",
                        "type": "bar",
                        "data": {"labels": ["a"], "series": {"s": [1]}},
                    }
                ]
            },
            {
                "charts": [{"title": "T", "type": "bar", "x": "region", "y": [1, 2]}],
                "source": "sales.csv",
            },
            {"kpis": [{"label": "Revenue", "value": 120}]},
        ):
            with self.assertRaises(dashboard.SpecError) as caught:
                self.build(bad)
            self.assertIn("derived", str(caught.exception))

    def test_derived_numbers_are_allowed_and_labelled(self) -> None:
        _, page = self.build(
            {
                "charts": [
                    {
                        "title": "T",
                        "type": "bar",
                        "derived": "growth rates from the Q3 board pack",
                        "data": {"labels": ["a", "b"], "series": {"s": [1, 2]}},
                    }
                ],
                "where": {"year": [2025, 2026]},
            }
        )
        self.assertIn("Derived: growth rates from the Q3 board pack", page)

    def test_unknown_column_names_the_columns(self) -> None:
        with self.assertRaises(dashboard.SpecError) as caught:
            self.build(
                {
                    "source": "sales.csv",
                    "charts": [{"title": "T", "x": "regoin", "y": "revenue"}],
                }
            )
        self.assertIn("Columns: date, region, revenue, units", str(caught.exception))

    def test_page_is_self_contained(self) -> None:
        _, page = self.build(
            {
                "source": "sales.csv",
                "charts": [
                    {"title": "T", "type": "pie", "x": "region", "y": "revenue"}
                ],
            }
        )
        self.assertNotRegex(page, r'(?:src|href)\s*=\s*["\']?(?:https?:)?//')
        self.assertNotRegex(page, r"@import|url\(\s*['\"]?https?:")
        self.assertIn("Chart.js v4.4.3", page)
        self.assertEqual(page.count("<script"), 3)

    def test_script_cannot_be_closed_by_data(self) -> None:
        (self.dir / "x.csv").write_text("name,v\n</script><b>x,1\n", "utf-8")
        _, page = self.build(
            {"source": "x.csv", "charts": [{"title": "T", "x": "name", "y": "v"}]}
        )
        self.assertNotIn("</script><b>", page)
        self.assertEqual(embedded(page)["charts"][0]["labels"], ["</script><b>x"])

    def test_format_matches_the_page_rules(self) -> None:
        self.assertEqual(
            dashboard.format_value(228753.39, {"prefix": "$", "compact": True}), "$229K"
        )
        self.assertEqual(
            dashboard.format_value(0.256, {"percent": True, "decimals": 1}), "25.6%"
        )
        self.assertEqual(dashboard.format_value(-1500, {"prefix": "$"}), "-$1,500")
        self.assertEqual(dashboard.format_value(None, {}), "–")

    def test_the_sales_fixture_builds(self) -> None:
        result = dashboard.build(FIXTURE, str(self.dir / "sales.dashboard.html"))
        self.assertEqual((result["kpis"], result["charts"]), (4, 5))


if __name__ == "__main__":
    unittest.main()
