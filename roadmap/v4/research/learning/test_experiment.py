"""Focused numerical and artifact binding checks; no training in ordinary JS test runs."""
import json
import unittest
from pathlib import Path

from experiment import digest, gradients

HERE=Path(__file__).resolve().parent


class ResearchChecks(unittest.TestCase):
    def test_gradient_matches_finite_differences_and_discrete_execution(self):
        result=gradients(json.loads((HERE/'profile.json').read_text()))
        self.assertLess(result['finiteDifferenceMaximumError'],0.001)
        self.assertEqual(result['selectedCandidate'],'x+1')
        self.assertTrue(result['heldoutDiscreteCorrect'])
        self.assertTrue(all(r['success'] and r['iterations']<=99 for r in result['fuzzing']))

    def test_recorded_artifacts_match_subject_and_budget(self):
        result=json.loads((HERE/'results/results.json').read_text())
        profile=json.loads((HERE/'profile.json').read_text())
        self.assertEqual(result['profileSHA256'],digest(HERE/'profile.json'))
        self.assertEqual(result['scriptSHA256'],digest(HERE/'experiment.py'))
        self.assertEqual(result['lora']['adapterSHA256'],digest(HERE/'results/adapter/adapters.safetensors'))
        self.assertEqual(result['lora']['corpusSHA256'],digest(HERE/'results/corpus.json'))
        self.assertLessEqual(result['lora']['trainingTokens'],profile['lora']['maximumTrainingTokens'])
        self.assertEqual(len(result['lora']['trainingSteps']),profile['lora']['steps'])
        self.assertTrue(result['lora']['baseUnchanged'])
        self.assertLessEqual(result['lora']['reloadMaximumLogitError'],0.0001)
        self.assertEqual(len(result['boundaryRate']['samples']),profile['boundaryRate']['trials'])
        for sample in result['boundaryRate']['samples']:
            self.assertEqual(sample['verdict'],'pass' if sample['inputsPerSecond']>=profile['boundaryRate']['minimumPerSecond'] else 'fail')
        corpus=json.loads((HERE/'results/corpus.json').read_text())
        self.assertTrue(set(corpus['train']).isdisjoint(corpus['heldout']))


if __name__=='__main__':
    unittest.main()
