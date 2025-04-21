#!/usr/bin/env python3
import gzip
import os
import argparse
import time
from pathlib import Path

import gffutils
from pyfaidx import Fasta
from tqdm import tqdm
from Bio import SeqIO


def create_db(gff_file):
    """Create an in-memory gffutils database from a GFF3 file, first checking for cached version."""
    # Generate expected db filename (same as gff with .db extension)
    db_file = f"{gff_file}.db"
    
    if os.path.exists(db_file):
        print(f"Loading database from {db_file} into memory...")
        start_time = time.time()
        # Load from disk to memory
        db = gffutils.FeatureDB(db_file)
        print(f"Database loaded in {time.time() - start_time:.2f} seconds")
        return db
    
    # Create database file if it doesn't exist
    db_file = f"{gff_file}.db"
    print(f"Creating database file {db_file} (this may take a while...)")
    db = gffutils.create_db(
        gff_file,
        dbfn=db_file,  # Save to disk for future use
        merge_strategy="create_unique",
        sort_attribute_values=True
    )
    
    return db


def process_genes(genes, fasta_file, output_dir, db, chromosome=None):
    """Process genes sequentially using a single FASTA and database instance."""
    # Filter genes by chromosome if specified
    if chromosome:
        genes = [g for g in genes if g.seqid == chromosome]
    
    total_genes = len(genes)
    print(f"Processing {total_genes} genes sequentially...")
    
    # Load the entire FASTA file into memory using BioPython
    print("Loading FASTA file into memory...")
    start_time = time.time()
    
    sequences = {}
    # Open with gzip if the file has a .gz extension
    if str(fasta_file).endswith('.gz'):
        with gzip.open(fasta_file, 'rt') as handle:  # 'rt' mode for text reading
            for record in SeqIO.parse(handle, "fasta"):
                sequences[record.id] = str(record.seq)
    else:
        for record in SeqIO.parse(fasta_file, "fasta"):
            sequences[record.id] = str(record.seq)
    
    print(f"FASTA loaded in {time.time() - start_time:.2f} seconds")
    
    # Create output directory if it doesn't exist
    output_dir.mkdir(parents=True, exist_ok=True)
    
    # Process each gene
    results = []
    for gene in tqdm(genes, desc="Extracting gene sequences"):
        result = extract_gene_sequence(gene, sequences, output_dir)
        results.append(result)
    
    # Collect errors
    errors = [r for r in results if r is not True]
    return errors


def extract_gene_sequence(gene, sequences, output_dir):
    """Extract a single gene's sequence using pre-loaded sequences."""
    # Get the gene name (e.g., BRCA2) from the Name attribute, fallback to gene_id
    gene_id = gene.id
    gene_name = gene.attributes.get('Name', [gene_id])[0]
    
    # Get the chromosome/scaffold and coordinates
    seqid = gene.seqid
    start = gene.start - 1  # Convert to 0-based
    end = gene.end
    
    # Get the full gene sequence from the in-memory dictionary
    gene_seq = sequences[seqid][start:end]
    
    # Use gene_name for the filename and header
    with gzip.open(output_dir / f"{gene_name}.fa.gz", 'wt') as f:
        f.write(f">{gene_name} {gene_id}\n")  # Include both name and ID in header
        f.write(f"{gene_seq}\n")
    
    return True


def main():
    parser = argparse.ArgumentParser(description='Extract gene sequences from Ensembl data using gene names')
    parser.add_argument('--gff', required=True, help='Path to GFF3 file')
    parser.add_argument('--fasta', required=True, help='Path to genome FASTA file')
    parser.add_argument('--output', default='gene_sequences', help='Output directory')
    parser.add_argument('--chromosome', type=str, default=None,
                        help='Process only genes on this chromosome (e.g., "1")')
    args = parser.parse_args()
    
    output_dir = Path(args.output)
    output_dir.mkdir(parents=True, exist_ok=True)
    
    print("Starting gene extraction process in sequential mode")
    total_start_time = time.time()
    
    # Create in-memory database from GFF file
    db_start_time = time.time()
    db = create_db(args.gff)
    db_time = time.time() - db_start_time
    print(f"Database creation took {db_time:.2f} seconds")
    
    # Get all genes from the database
    print("Fetching genes from database...")
    genes_start_time = time.time()
    genes = list(db.features_of_type('gene'))
    genes_time = time.time() - genes_start_time
    print(f"Found {len(genes)} genes")
    print(f"Gene fetching took {genes_time:.2f} seconds")
    
    # Process genes sequentially
    process_start_time = time.time()
    errors = process_genes(genes, args.fasta, output_dir, db, args.chromosome)
    process_time = time.time() - process_start_time
    print(f"Processing took {process_time:.2f} seconds")
    
    total_time = time.time() - total_start_time
    print(f"Total execution time: {total_time:.2f} seconds")
    
    # Create summary
    print("\nPerformance Summary:")
    print(f"  Database preparation: {db_time:.2f}s ({db_time/total_time:.1%})")
    print(f"  Gene fetching:        {genes_time:.2f}s ({genes_time/total_time:.1%})")
    print(f"  Sequence extraction:  {process_time:.2f}s ({process_time/total_time:.1%})")
    print(f"  Total time:           {total_time:.2f}s")
    print(f"  Genes per second:     {len(genes)/process_time:.2f}")
    
    # Report errors
    if errors:
        print(f"\nEncountered {len(errors)} errors:")
        for gene_id, error in errors[:10]:  # Show first 10 errors
            print(f"  {gene_id}: {error}")
        if len(errors) > 10:
            print(f"  ... and {len(errors) - 10} more")


if __name__ == "__main__":
    main()
